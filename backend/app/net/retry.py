"""Retry with exponential backoff + jitter for outbound HTTP (LLM, channels, STT).

Retries transport errors, timeouts and HTTP 408/425/429/5xx. Honors ``Retry-After``.
Client errors (4xx other than the above) are never retried.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

T = TypeVar("T")

RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_STATUS
    return isinstance(exc, (httpx.TransportError, httpx.TimeoutException))


def _retry_after(exc: BaseException) -> float | None:
    if isinstance(exc, httpx.HTTPStatusError):
        raw = exc.response.headers.get("retry-after")
        if raw:
            try:
                return max(0.0, float(raw))
            except ValueError:
                return None
    return None


def backoff_delay(attempt: int, base: float, cap: float, hint: float | None = None) -> float:
    """attempt is 1-based (the attempt that just failed)."""
    if hint is not None:
        return min(hint, cap)
    delay = min(cap, base * (2 ** (attempt - 1)))
    return delay * (0.5 + random.random() / 2)  # jitter: 50–100 % of the nominal delay


async def with_retry(
    fn: Callable[[], Awaitable[T]],
    *,
    attempts: int | None = None,
    base_delay: float | None = None,
    max_delay: float | None = None,
    should_retry: Callable[[BaseException], bool] = is_retryable,
    label: str = "http",
) -> T:
    s = get_settings()
    attempts = max(1, attempts if attempts is not None else s.http_retry_attempts)
    base = s.http_retry_base_delay if base_delay is None else base_delay
    cap = s.http_retry_max_delay if max_delay is None else max_delay
    last: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await fn()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt >= attempts or not should_retry(exc):
                raise
            delay = backoff_delay(attempt, base, cap, _retry_after(exc))
            logger.warning("%s failed (%s), retry %d/%d in %.2fs", label, exc, attempt, attempts - 1, delay)
            if delay > 0:
                await asyncio.sleep(delay)
    assert last is not None  # pragma: no cover
    raise last  # pragma: no cover


async def request_json(
    method: str,
    url: str,
    *,
    timeout: float = 30.0,
    label: str = "http",
    **kwargs: Any,
) -> httpx.Response:
    """One resilient HTTP call that raises for non-2xx after retries are exhausted."""

    async def _once() -> httpx.Response:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.request(method, url, **kwargs)
            r.raise_for_status()
            return r

    return await with_retry(_once, label=label)
