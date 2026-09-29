from __future__ import annotations

from typing import Any

from app.config import get_settings

_client: Any = None


def get_redis() -> Any:
    """Shared asyncio Redis client (lazy). Tests inject fakeredis via set_redis()."""
    global _client
    if _client is None:
        import redis.asyncio as aioredis

        _client = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _client


def set_redis(client: Any) -> None:
    global _client
    _client = client


async def close_redis() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:  # noqa: BLE001
            pass
        _client = None
