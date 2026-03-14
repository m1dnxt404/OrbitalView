import asyncio
import httpx
import logging
import time
from typing import Optional

from models.schemas import AircraftPosition
from config import settings

logger = logging.getLogger(__name__)

OPENSKY_URL = "https://opensky-network.org/api/states/all"

# Short-lived cache so concurrent calls within the same broadcast cycle
# (aircraft layer + military ICAO fallback) share one HTTP request instead of two.
_aircraft_cache: list[AircraftPosition] = []
_aircraft_cache_time: float = 0.0
_aircraft_lock: asyncio.Lock | None = None
AIRCRAFT_CACHE_TTL = 12.0  # seconds — just over one broadcast cycle


OPENSKY_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)


def _get_lock() -> asyncio.Lock:
    """Return the module-level lock, creating it lazily inside the event loop."""
    global _aircraft_lock
    if _aircraft_lock is None:
        _aircraft_lock = asyncio.Lock()
    return _aircraft_lock

# OpenSky state vector field indices (documented at opensky-network.org/apidoc)
_IDX_ICAO24 = 0
_IDX_CALLSIGN = 1
_IDX_ORIGIN_COUNTRY = 2
_IDX_LAST_CONTACT = 4
_IDX_LONGITUDE = 5
_IDX_LATITUDE = 6
_IDX_BARO_ALTITUDE = 7
_IDX_ON_GROUND = 8
_IDX_VELOCITY = 9
_IDX_HEADING = 10
_IDX_VERTICAL_RATE = 11

# In-memory token cache — resets when the process restarts.
_token: str = ""
_token_expires_at: float = 0.0

_rate_limited_until: float = 0.0
_backoff_seconds: float = 60.0
_MAX_RATE_LIMIT_BACKOFF: float = 300.0
_last_success_at: float = 0.0


def get_source_status() -> dict:
    now = time.monotonic()
    return {
        "last_success": _last_success_at or None,
        "is_rate_limited": now < _rate_limited_until,
        "rate_limited_for_s": max(0, int(_rate_limited_until - now)),
    }


async def _get_bearer_token() -> str:
    """Obtain (or return a cached) OAuth2 bearer token via client credentials."""
    global _token, _token_expires_at

    if _token and time.monotonic() < _token_expires_at:
        return _token

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            OPENSKY_TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": settings.OPENSKY_CLIENT_ID,
                "client_secret": settings.OPENSKY_CLIENT_SECRET,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    _token = data["access_token"]
    expires_in = int(data.get("expires_in", 300))
    _token_expires_at = time.monotonic() + expires_in - 30  # 30 s safety buffer
    logger.info("Obtained new OpenSky OAuth2 token (expires in %d s)", expires_in)
    return _token


def _parse_state_vector(state: list) -> Optional[AircraftPosition]:
    """Parse a single OpenSky state vector into an AircraftPosition.

    Returns None if the aircraft has no position data.
    """
    try:
        longitude = state[_IDX_LONGITUDE]
        latitude = state[_IDX_LATITUDE]
        if longitude is None or latitude is None:
            return None

        return AircraftPosition(
            icao24=state[_IDX_ICAO24] or "",
            callsign=(state[_IDX_CALLSIGN] or "").strip(),
            origin_country=state[_IDX_ORIGIN_COUNTRY] or "",
            longitude=longitude,
            latitude=latitude,
            altitude=state[_IDX_BARO_ALTITUDE],
            velocity=state[_IDX_VELOCITY],
            heading=state[_IDX_HEADING],
            vertical_rate=state[_IDX_VERTICAL_RATE],
            on_ground=bool(state[_IDX_ON_GROUND]),
            last_contact=state[_IDX_LAST_CONTACT],
        )
    except (IndexError, TypeError) as exc:
        logger.warning("Skipping malformed state vector: %s", exc)
        return None


async def fetch_aircraft() -> list[AircraftPosition]:
    """Fetch all live aircraft positions globally from OpenSky.

    Auth priority:
      1. OAuth2 client credentials  (OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET)
      2. Basic auth                 (OPENSKY_USERNAME + OPENSKY_PASSWORD)
      3. Anonymous                  (no credentials — heavily rate-limited)

    Concurrent calls within the same broadcast cycle (e.g. aircraft layer +
    military ICAO fallback) share one HTTP request via a short-lived cache.

    Returns an empty list on any network failure — never raises.
    """
    global _aircraft_cache, _aircraft_cache_time, _rate_limited_until, _backoff_seconds, _last_success_at

    now = time.monotonic()
    if now < _rate_limited_until:
        logger.info("OpenSky rate-limited — skipping for %ds", int(_rate_limited_until - now))
        return _aircraft_cache

    # Fast path — serve from cache without acquiring the lock.
    if _aircraft_cache and (now - _aircraft_cache_time) < AIRCRAFT_CACHE_TTL:
        logger.debug("fetch_aircraft: cache hit (%d aircraft)", len(_aircraft_cache))
        return _aircraft_cache

    # Slow path — one coroutine fetches, the rest wait and then get the cache.
    async with _get_lock():
        now = time.monotonic()
        if _aircraft_cache and (now - _aircraft_cache_time) < AIRCRAFT_CACHE_TTL:
            logger.debug("fetch_aircraft: post-lock cache hit (%d aircraft)", len(_aircraft_cache))
            return _aircraft_cache

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                if settings.OPENSKY_CLIENT_ID and settings.OPENSKY_CLIENT_SECRET:
                    token = await _get_bearer_token()
                    response = await client.get(
                        OPENSKY_URL,
                        headers={"Authorization": f"Bearer {token}"},
                    )
                elif settings.OPENSKY_USERNAME and settings.OPENSKY_PASSWORD:
                    response = await client.get(
                        OPENSKY_URL,
                        auth=(settings.OPENSKY_USERNAME, settings.OPENSKY_PASSWORD),
                    )
                else:
                    response = await client.get(OPENSKY_URL)

                response.raise_for_status()
                data = response.json()

            states = data.get("states") or []
            aircraft = [_parse_state_vector(s) for s in states]
            result = [a for a in aircraft if a is not None]

            _aircraft_cache = result
            _aircraft_cache_time = time.monotonic()
            _last_success_at = time.time()
            _backoff_seconds = 60.0
            logger.info("Fetched %d aircraft from OpenSky", len(result))
            return result

        except httpx.TimeoutException:
            logger.error("OpenSky request timed out")
            return _aircraft_cache  # return stale data rather than empty list
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                _rate_limited_until = time.monotonic() + _backoff_seconds
                logger.warning("Rate limited by OpenSky — backing off for %ds", int(_backoff_seconds))
                _backoff_seconds = min(_backoff_seconds * 2, _MAX_RATE_LIMIT_BACKOFF)
                return _aircraft_cache
            logger.error("OpenSky HTTP %s: %s", exc.response.status_code, exc.response.text[:200])
            return _aircraft_cache
        except Exception as exc:
            logger.exception("Unexpected error fetching aircraft: %s", exc)
            return _aircraft_cache
