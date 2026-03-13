import asyncio
import logging
import time
from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from ingestion.opensky import fetch_aircraft
from ingestion.adsb_exchange import fetch_military_aircraft
from ingestion.celestrak import fetch_tles
from ingestion.usgs import fetch_earthquakes
from ingestion.aircraft_metadata import fetch_new_typecodes, get_typecode
from models.schemas import (
    AircraftPosition,
    EarthquakeEvent,
    GeoJSONFeature,
    GeoJSONFeatureCollection,
    GeoJSONPoint,
    TLERecord,
    WorldPayload,
)
from config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.add(websocket)
        logger.info("Client connected. Total: %d", len(self._connections))

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)
        logger.info("Client disconnected. Total: %d", len(self._connections))

    async def broadcast(self, message: str) -> None:
        dead: set[WebSocket] = set()
        for ws in self._connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead.add(ws)
        self._connections -= dead

    @property
    def connection_count(self) -> int:
        return len(self._connections)


manager = ConnectionManager()

_position_history: dict[str, deque] = {}


def _update_position_history(aircraft_list: list[AircraftPosition]) -> None:
    active: set[str] = set()
    for ac in aircraft_list:
        if ac.latitude is None or ac.longitude is None:
            continue
        active.add(ac.icao24)
        if ac.icao24 not in _position_history:
            _position_history[ac.icao24] = deque(maxlen=settings.TRAIL_MAX_LENGTH)
        _position_history[ac.icao24].append([ac.longitude, ac.latitude, ac.altitude])
    for key in list(_position_history):
        if key not in active:
            del _position_history[key]


def _build_aircraft_geojson(aircraft_list: list[AircraftPosition]) -> GeoJSONFeatureCollection:
    features = []
    for ac in aircraft_list:
        if ac.latitude is None or ac.longitude is None:
            continue
        features.append(
            GeoJSONFeature(
                geometry=GeoJSONPoint(coordinates=[ac.longitude, ac.latitude]),
                properties={
                    "icao24": ac.icao24,
                    "callsign": ac.callsign,
                    "origin_country": ac.origin_country,
                    "altitude": ac.altitude,
                    "velocity": ac.velocity,
                    "heading": ac.heading,
                    "vertical_rate": ac.vertical_rate,
                    "on_ground": ac.on_ground,
                    "trail": list(_position_history.get(ac.icao24, [])),
                    "typecode": get_typecode(ac.icao24),
                },
            )
        )
    return GeoJSONFeatureCollection(features=features)


def _build_earthquake_geojson(quakes: list[EarthquakeEvent]) -> GeoJSONFeatureCollection:
    features = []
    for eq in quakes:
        features.append(
            GeoJSONFeature(
                geometry=GeoJSONPoint(coordinates=[eq.longitude, eq.latitude]),
                properties={
                    "id": eq.id,
                    "magnitude": eq.magnitude,
                    "place": eq.place,
                    "depth_km": eq.depth_km,
                    "time_ms": eq.time_ms,
                },
            )
        )
    return GeoJSONFeatureCollection(features=features)


async def broadcast_loop() -> None:
    logger.info("Broadcast loop started. Interval: %ds", settings.POLLING_INTERVAL_SECONDS)
    while True:
        cycle_start = time.monotonic()
        try:
            if manager.connection_count > 0:
                results = await asyncio.gather(
                    fetch_aircraft(),
                    fetch_tles(),
                    fetch_earthquakes(),
                    return_exceptions=True,
                )

                aircraft = results[0] if not isinstance(results[0], BaseException) else []
                tles     = results[1] if not isinstance(results[1], BaseException) else []
                quakes   = results[2] if not isinstance(results[2], BaseException) else []
                military = await fetch_military_aircraft(aircraft)

                # Deduplicate by icao24 so military aircraft (often a subset of
                # civilian fetch) don't get double-counted in history.
                all_tracked = {ac.icao24: ac for ac in aircraft}
                for m in military:
                    all_tracked.setdefault(m.icao24, m)
                _update_position_history(list(all_tracked.values()))
                await fetch_new_typecodes(list(all_tracked.keys()))

                payload = WorldPayload(
                    aircraft=_build_aircraft_geojson(aircraft),
                    military=_build_aircraft_geojson(military),
                    tles=tles,
                    earthquakes=_build_earthquake_geojson(quakes),
                    counts={
                        "aircraft": len(aircraft),
                        "military": len(military),
                        "satellites": len(tles),
                        "earthquakes": len(quakes),
                    },
                )
                await manager.broadcast(payload.model_dump_json())
                logger.info(
                    "Broadcast: ac=%d mil=%d tle=%d eq=%d to %d client(s)",
                    len(aircraft),
                    len(military),
                    len(tles),
                    len(quakes),
                    manager.connection_count,
                )
            else:
                logger.debug("No clients — skipping cycle")
        except Exception as exc:
            logger.exception("Broadcast cycle error: %s", exc)

        elapsed = time.monotonic() - cycle_start
        await asyncio.sleep(max(0.0, settings.POLLING_INTERVAL_SECONDS - elapsed))


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(broadcast_loop())
    logger.info("OrbitalView backend started")
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        logger.info("Broadcast loop stopped")


app = FastAPI(title="OrbitalView API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "status": "healthy",
        "connections": manager.connection_count,
        "polling_interval": settings.POLLING_INTERVAL_SECONDS,
    }


@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
        manager.disconnect(websocket)
