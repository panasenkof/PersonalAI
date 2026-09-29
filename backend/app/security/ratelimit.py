from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from typing import Protocol

logger = logging.getLogger(__name__)


class SlidingWindowLimiter:
    """Per-key sliding window counter (in-process; single-instance deployments)."""

    def __init__(self, limit: int, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        if self.limit <= 0:
            return True
        now = time.monotonic()
        q = self._hits[key]
        while q and q[0] <= now - self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True

    def count(self, key: str) -> int:
        now = time.monotonic()
        q = self._hits[key]
        while q and q[0] <= now - self.window:
            q.popleft()
        return len(q)

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)


class AsyncLimiter(Protocol):
    async def allow(self, key: str) -> bool: ...

    async def count(self, key: str) -> int: ...

    async def reset(self, key: str) -> None: ...


class MemoryLimiter:
    """Async facade over the in-process sliding window."""

    def __init__(self, limit: int, window_seconds: int = 60) -> None:
        self._inner = SlidingWindowLimiter(limit, window_seconds)

    async def allow(self, key: str) -> bool:
        return self._inner.allow(key)

    async def count(self, key: str) -> int:
        return self._inner.count(key)

    async def reset(self, key: str) -> None:
        self._inner.reset(key)


class RedisLimiter:
    """Fixed-window counter shared by all replicas (INCR + EXPIRE).

    Falls back to the in-process window when Redis is unreachable so a Redis outage
    degrades to per-replica limits instead of blocking all traffic.
    """

    def __init__(self, redis, name: str, limit: int, window_seconds: int = 60) -> None:  # noqa: ANN001
        self.redis = redis
        self.name = name
        self.limit = limit
        self.window = window_seconds
        self._fallback = MemoryLimiter(limit, window_seconds)

    def _key(self, key: str) -> str:
        bucket = int(time.time() // self.window)
        return f"pia:rl:{self.name}:{key}:{bucket}"

    async def allow(self, key: str) -> bool:
        if self.limit <= 0:
            return True
        try:
            rk = self._key(key)
            n = await self.redis.incr(rk)
            if n == 1:
                await self.redis.expire(rk, self.window * 2)
            return int(n) <= self.limit
        except Exception as exc:  # noqa: BLE001
            logger.warning("redis limiter unavailable (%s); using local window", exc)
            return await self._fallback.allow(key)

    async def count(self, key: str) -> int:
        try:
            return int(await self.redis.get(self._key(key)) or 0)
        except Exception:  # noqa: BLE001
            return await self._fallback.count(key)

    async def reset(self, key: str) -> None:
        try:
            await self.redis.delete(self._key(key))
        except Exception:  # noqa: BLE001
            pass
        await self._fallback.reset(key)


def build_limiter(name: str, limit: int, window_seconds: int = 60) -> AsyncLimiter:
    """Redis-backed when REDIS_URL is configured, otherwise in-process."""
    from app.config import get_settings

    s = get_settings()
    if s.redis_url and limit > 0:
        from app.queue.redis_client import get_redis

        return RedisLimiter(get_redis(), name, limit, window_seconds)
    return MemoryLimiter(limit, window_seconds)
