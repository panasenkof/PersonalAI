from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

logger = logging.getLogger(__name__)

EVENTS_CHANNEL_PREFIX = "pia:events:"
CONTROL_CHANNEL = "pia:control"
TERMINAL_EVENTS = frozenset({"done", "error", "cancelled"})

CancelCallback = Callable[[str], Awaitable[None] | None]


class EventBus:
    """Job event fan-out (tokens, tool calls, completion, cancel control).

    Local mode: in-process pub/sub (single instance). After ``attach_redis`` events and
    control messages travel through Redis pub/sub, so SSE clients connected to *any* API
    replica see events produced by *any* worker. Every process keeps a small replay buffer
    per job so subscribers that connect a moment late still get the whole stream.
    """

    def __init__(self, history_size: int = 500, history_ttl: float = 60.0) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._history: dict[str, deque[dict[str, Any]]] = {}
        self._history_expiry: dict[str, float] = {}
        self._history_size = history_size
        self._history_ttl = history_ttl
        self._cancel_callbacks: list[CancelCallback] = []
        self._cancel_requested: dict[str, float] = {}
        self._redis: Any = None
        self._listener: asyncio.Task | None = None

    # --- subscriptions ---------------------------------------------------------------------
    def subscribe(self, job_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._history_size + 1000)
        for ev in self._history.get(job_id, ()):  # replay what happened before we subscribed
            q.put_nowait(ev)
        self._subs.setdefault(job_id, set()).add(q)
        return q

    def unsubscribe(self, job_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        subs = self._subs.get(job_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subs.pop(job_id, None)

    # --- publishing ------------------------------------------------------------------------
    def _deliver(self, job_id: str, event: dict[str, Any]) -> None:
        self._gc_history()
        hist = self._history.setdefault(job_id, deque(maxlen=self._history_size))
        hist.append(event)
        self._history_expiry[job_id] = time.monotonic() + self._history_ttl
        for q in list(self._subs.get(job_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow consumer: drop rather than block the worker

    def _gc_history(self) -> None:
        now = time.monotonic()
        for jid in [j for j, t in self._history_expiry.items() if t < now and j not in self._subs]:
            self._history.pop(jid, None)
            self._history_expiry.pop(jid, None)

    async def publish(self, job_id: str, event: dict[str, Any]) -> None:
        if self._redis is not None:
            try:
                await self._redis.publish(EVENTS_CHANNEL_PREFIX + job_id, json.dumps(event, ensure_ascii=False))
                return  # the listener (in every process, including this one) delivers it
            except Exception as exc:  # noqa: BLE001
                logger.warning("redis publish failed (%s); delivering locally", exc)
        self._deliver(job_id, event)

    def publisher(self, job_id: str):
        """Callable passed into the agent: async publish(event)."""

        async def _emit(event: dict[str, Any]) -> None:
            await self.publish(job_id, event)

        return _emit

    # --- control (cancel) ------------------------------------------------------------------
    def on_cancel(self, cb: CancelCallback) -> None:
        if cb not in self._cancel_callbacks:
            self._cancel_callbacks.append(cb)

    def consume_cancel(self, job_id: str) -> bool:
        """True (once) if a cancel was requested for `job_id` — lets the owner tell Stop from shutdown
        even when the DB row cannot be updated yet (SQLite write lock held by the running job)."""
        return self._cancel_requested.pop(job_id, None) is not None

    def _mark_cancel(self, job_id: str) -> None:
        now = time.monotonic()
        for jid in [j for j, t in self._cancel_requested.items() if now - t > 600]:
            del self._cancel_requested[jid]
        self._cancel_requested[job_id] = now

    async def _run_cancel_callbacks(self, job_id: str) -> None:
        self._mark_cancel(job_id)
        for cb in list(self._cancel_callbacks):
            try:
                res = cb(job_id)
                if asyncio.iscoroutine(res):
                    await res
            except Exception:  # noqa: BLE001
                logger.exception("cancel callback failed")

    async def request_cancel(self, job_id: str) -> None:
        """Ask whichever worker runs `job_id` to stop it (cluster-wide when Redis is attached)."""
        if self._redis is not None:
            try:
                await self._redis.publish(CONTROL_CHANNEL, json.dumps({"op": "cancel", "job_id": job_id}))
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning("redis control publish failed (%s); cancelling locally", exc)
        await self._run_cancel_callbacks(job_id)

    # --- redis transport -------------------------------------------------------------------
    async def attach_redis(self, redis: Any) -> None:
        await self.detach_redis()
        self._redis = redis
        ready = asyncio.Event()
        self._listener = asyncio.create_task(self._listen(ready))
        try:
            await asyncio.wait_for(ready.wait(), timeout=5)
        except TimeoutError:
            logger.warning("redis event listener did not become ready in time")

    async def detach_redis(self) -> None:
        task, self._listener = self._listener, None
        self._redis = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _listen(self, ready: asyncio.Event) -> None:
        redis = self._redis
        backoff = 0.5
        while redis is not None:
            pubsub = redis.pubsub()
            try:
                await pubsub.psubscribe(EVENTS_CHANNEL_PREFIX + "*")
                await pubsub.subscribe(CONTROL_CHANNEL)
                ready.set()
                backoff = 0.5
                while True:
                    msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if msg is None:
                        continue
                    await self._handle_redis_message(msg)
            except asyncio.CancelledError:
                try:
                    await pubsub.aclose()
                except Exception:  # noqa: BLE001
                    pass
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("redis event listener error: %s (reconnect in %.1fs)", exc, backoff)
                ready.set()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    async def _handle_redis_message(self, msg: dict[str, Any]) -> None:
        channel = msg.get("channel")
        if isinstance(channel, bytes):
            channel = channel.decode()
        raw = msg.get("data")
        try:
            data = json.loads(raw or "")
        except (TypeError, ValueError):
            return
        if channel == CONTROL_CHANNEL:
            if data.get("op") == "cancel" and data.get("job_id"):
                await self._run_cancel_callbacks(str(data["job_id"]))
            return
        if isinstance(channel, str) and channel.startswith(EVENTS_CHANNEL_PREFIX):
            self._deliver(channel[len(EVENTS_CHANNEL_PREFIX) :], data)


bus = EventBus()
