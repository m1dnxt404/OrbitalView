import asyncio
import httpx
import logging
import time

from models.schemas import TLERecord
from config import settings

logger = logging.getLogger(__name__)

CELESTRAK_URL = "https://celestrak.org/pub/TLE/active.txt"
CACHE_TTL_SECONDS = 1800  # 30 minutes

_TIMEOUT = httpx.Timeout(connect=45.0, read=60.0, write=5.0, pool=5.0)
_MAX_RETRIES = 3
_RETRY_BACKOFF = 3.0  # seconds; multiplied by attempt number

_tle_cache: list[tuple[str, str, str]] = []   # (name, line1, line2)
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


def _parse_tle_text(text: str) -> list[tuple[str, str, str]]:
    """Parse raw TLE text into (name, line1, line2) tuples."""
    entries = []
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    i = 0
    while i + 2 < len(lines):
        name = lines[i]
        line1 = lines[i + 1]
        line2 = lines[i + 2]
        if line1.startswith("1 ") and line2.startswith("2 "):
            entries.append((name, line1, line2))
            i += 3
        else:
            i += 1
    return entries


async def fetch_tles() -> list[TLERecord]:
    """Fetch TLE data from CelesTrak (cached 30 min) and return raw TLE records.

    SGP4 propagation is handled on the frontend via satellite.js.
    Returns an empty list on failure — never raises.
    """
    global _tle_cache, _cache_time, _rate_limited_until, _backoff_seconds, _last_success_at

    now = time.monotonic()
    if now < _rate_limited_until:
        logger.info("CelesTrak rate-limited — skipping for %ds", int(_rate_limited_until - now))
        return [
            TLERecord(norad_id=l1[2:7].strip(), name=name, line1=l1, line2=l2)
            for name, l1, l2 in _tle_cache[:settings.MAX_SATELLITES]
        ] if _tle_cache else []

    if not _tle_cache or (now - _cache_time) > CACHE_TTL_SECONDS:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            for attempt in range(1, _MAX_RETRIES + 1):
                try:
                    resp = await client.get(
                        CELESTRAK_URL,
                        headers={"User-Agent": "OrbitalView-Tracker/2.0 (geospatial research)"},
                    )
                    resp.raise_for_status()
                    _tle_cache = _parse_tle_text(resp.text)
                    _cache_time = now
                    _last_success_at = time.time()
                    _backoff_seconds = 60.0
                    logger.info("Refreshed TLE cache: %d entries", len(_tle_cache))
                    break
                except (httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
                    if attempt < _MAX_RETRIES:
                        delay = _RETRY_BACKOFF * attempt
                        logger.warning(
                            "CelesTrak timeout (attempt %d/%d), retrying in %.0fs: %s",
                            attempt, _MAX_RETRIES, delay, exc,
                        )
                        await asyncio.sleep(delay)
                    else:
                        logger.exception("CelesTrak fetch failed after %d attempts", _MAX_RETRIES)
                        if not _tle_cache:
                            return []
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 429:
                        _rate_limited_until = time.monotonic() + _backoff_seconds
                        logger.warning("Rate limited by CelesTrak — backing off for %ds", int(_backoff_seconds))
                        _backoff_seconds = min(_backoff_seconds * 2, _MAX_RATE_LIMIT_BACKOFF)
                        return [
                            TLERecord(norad_id=l1[2:7].strip(), name=name, line1=l1, line2=l2)
                            for name, l1, l2 in _tle_cache[:settings.MAX_SATELLITES]
                        ] if _tle_cache else []
                    logger.exception("CelesTrak fetch failed: %s", exc)
                    if not _tle_cache:
                        return []
                    break
                except Exception as exc:
                    logger.exception("CelesTrak fetch failed: %s", exc)
                    if not _tle_cache:
                        return []
                    break

    result = [
        TLERecord(norad_id=l1[2:7].strip(), name=name, line1=l1, line2=l2)
        for name, l1, l2 in _tle_cache[:settings.MAX_SATELLITES]
    ]
    logger.info("Returning %d TLE records", len(result))
    return result
