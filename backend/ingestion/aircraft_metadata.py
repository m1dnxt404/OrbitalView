import asyncio
import logging
import time

import httpx

from config import settings
from ingestion.opensky import _get_bearer_token

logger = logging.getLogger(__name__)

METADATA_URL = "https://opensky-network.org/api/metadata/aircraft/icao/{}"

# Permanent in-memory cache — aircraft type doesn't change, so no TTL needed.
_typecode_cache: dict[str, str] = {}  # icao24 → typecode (empty string = unknown/failed)

_rate_limited_until: float = 0.0
_backoff_seconds: float = 60.0
_MAX_RATE_LIMIT_BACKOFF: float = 300.0


async def fetch_new_typecodes(icao24_list: list[str]) -> None:
    """Fetch typecodes for aircraft not yet in cache.

    Capped at settings.METADATA_FETCH_PER_CYCLE requests per call to avoid rate-limiting.
    On any error or 404, caches an empty string to prevent retrying the same aircraft.
    """
    now = time.monotonic()
    if now < _rate_limited_until:
        logger.info("OpenSky metadata rate-limited — skipping for %ds", int(_rate_limited_until - now))
        return

    unknown = [i for i in icao24_list if i and i not in _typecode_cache]
    if not unknown:
        return

    to_fetch = unknown[:settings.METADATA_FETCH_PER_CYCLE]
    async with httpx.AsyncClient(timeout=5.0) as client:
        await asyncio.gather(
            *[_fetch_one(client, icao24) for icao24 in to_fetch],
            return_exceptions=True,
        )
    logger.debug(
        "Metadata: resolved %d typecodes. Cache size: %d",
        len(to_fetch),
        len(_typecode_cache),
    )


async def _fetch_one(client: httpx.AsyncClient, icao24: str) -> None:
    url = METADATA_URL.format(icao24.lower())
    try:
        if settings.OPENSKY_CLIENT_ID and settings.OPENSKY_CLIENT_SECRET:
            token = await _get_bearer_token()
            resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        elif settings.OPENSKY_USERNAME and settings.OPENSKY_PASSWORD:
            resp = await client.get(url, auth=(settings.OPENSKY_USERNAME, settings.OPENSKY_PASSWORD))
        else:
            resp = await client.get(url)

        if resp.status_code == 200:
            data = resp.json()
            _typecode_cache[icao24] = (data.get("typecode") or "").strip().upper()
        elif resp.status_code == 429:
            global _rate_limited_until, _backoff_seconds
            _rate_limited_until = time.monotonic() + _backoff_seconds
            logger.warning("Rate limited by OpenSky metadata — backing off for %ds", int(_backoff_seconds))
            _backoff_seconds = min(_backoff_seconds * 2, _MAX_RATE_LIMIT_BACKOFF)
            # Do not cache empty string — allow retry after cooldown
        else:
            _typecode_cache[icao24] = ""
    except Exception:
        _typecode_cache[icao24] = ""


def get_typecode(icao24: str) -> str:
    return _typecode_cache.get(icao24, "")
