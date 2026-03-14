import httpx
import logging
import time

from models.schemas import EarthquakeEvent

logger = logging.getLogger(__name__)

USGS_URL = (
    "https://earthquake.usgs.gov/fdsnws/event/1/query"
    "?format=geojson&minmagnitude=2.5&orderby=time&limit=500"
)
CACHE_TTL_SECONDS = 60

_cache: list[EarthquakeEvent] = []
_cache_time: float = 0.0

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


def _parse_feature(feature: dict) -> EarthquakeEvent | None:
    """Parse a single USGS GeoJSON feature into an EarthquakeEvent."""
    try:
        props = feature["properties"]
        coords = feature["geometry"]["coordinates"]  # [lon, lat, depth_km]
        return EarthquakeEvent(
            id=feature["id"],
            magnitude=float(props["mag"]),
            place=props.get("place") or "",
            longitude=float(coords[0]),
            latitude=float(coords[1]),
            depth_km=float(coords[2]),
            time_ms=int(props["time"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        logger.debug("Skipping malformed earthquake feature: %s", exc)
        return None


async def fetch_earthquakes() -> list[EarthquakeEvent]:
    """Fetch recent earthquakes from USGS (cached 60s).

    Returns an empty list on failure — never raises.
    """
    global _cache, _cache_time, _rate_limited_until, _backoff_seconds, _last_success_at

    now = time.monotonic()
    if now < _rate_limited_until:
        logger.info("USGS rate-limited — skipping for %ds", int(_rate_limited_until - now))
        return _cache

    if _cache and (now - _cache_time) < CACHE_TTL_SECONDS:
        return _cache

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(USGS_URL)
            resp.raise_for_status()
            data = resp.json()

        features = data.get("features") or []
        events = [_parse_feature(f) for f in features]
        _cache = [e for e in events if e is not None]
        _cache_time = now
        _last_success_at = time.time()
        _backoff_seconds = 60.0
        logger.info("Fetched %d earthquake events from USGS", len(_cache))
        return _cache

    except httpx.TimeoutException:
        logger.error("USGS request timed out")
        return _cache
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            _rate_limited_until = time.monotonic() + _backoff_seconds
            logger.warning("Rate limited by USGS — backing off for %ds", int(_backoff_seconds))
            _backoff_seconds = min(_backoff_seconds * 2, _MAX_RATE_LIMIT_BACKOFF)
            return _cache
        logger.exception("Unexpected error fetching earthquakes: %s", exc)
        return _cache
    except Exception as exc:
        logger.exception("Unexpected error fetching earthquakes: %s", exc)
        return _cache
