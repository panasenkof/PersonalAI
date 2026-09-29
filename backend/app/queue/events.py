from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    """In-process pub/sub for job events (tokens, tool calls, completion).

    Works for the in-process runner; a Redis pub/sub backend can implement the
    same interface later without touching SSE code.
    """

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}

    def subscribe(self, job_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._subs.setdefault(job_id, set()).add(q)
        return q

    def unsubscribe(self, job_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        subs = self._subs.get(job_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subs.pop(job_id, None)

    async def publish(self, job_id: str, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(job_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow consumer: drop rather than block the worker

    def publisher(self, job_id: str):
        """Callable passed into the agent: async publish(event)."""

        async def _emit(event: dict[str, Any]) -> None:
            await self.publish(job_id, event)

        return _emit


bus = EventBus()
