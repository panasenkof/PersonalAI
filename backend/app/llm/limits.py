"""LLM cost/pressure protection: process-wide concurrency cap and per-user quota."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from app.config import get_settings
from app.security.ratelimit import AsyncLimiter, build_limiter

logger = logging.getLogger(__name__)


class RateLimitExceeded(Exception):
    """Raised when a user exceeded the LLM message quota."""

    def __init__(self, retry_after: int = 60) -> None:
        super().__init__("rate_limited")
        self.retry_after = retry_after


_sem: asyncio.Semaphore | None = None
_sem_loop: asyncio.AbstractEventLoop | None = None
_limiter: AsyncLimiter | None = None


@asynccontextmanager
async def llm_slot() -> AsyncIterator[None]:
    """Bound concurrent outbound LLM calls of this process (protects providers and our loop)."""
    global _sem, _sem_loop
    loop = asyncio.get_running_loop()
    if _sem is None or _sem_loop is not loop:  # semaphores bind to a loop (tests create many)
        _sem = asyncio.Semaphore(max(1, get_settings().llm_max_concurrency))
        _sem_loop = loop
    async with _sem:
        yield


def _get_limiter() -> AsyncLimiter:
    global _limiter
    if _limiter is None:
        _limiter = build_limiter("llm", get_settings().rate_limit_llm_per_minute)
    return _limiter


def reset_llm_limiter() -> None:
    """Drop cached limiter (tests / settings reload)."""
    global _limiter
    _limiter = None


async def check_user_quota(user_id: str) -> None:
    """Raise RateLimitExceeded when the user sent too many LLM-bound messages this minute."""
    if get_settings().rate_limit_llm_per_minute <= 0:
        return
    if not await _get_limiter().allow(user_id):
        raise RateLimitExceeded()
