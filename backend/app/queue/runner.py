from __future__ import annotations

import asyncio
import logging
import socket
import uuid
from datetime import timedelta
from typing import Any, Protocol

from sqlalchemy import select, update

from app.config import get_settings
from app.db import SessionLocal
from app.ingestion.schemas import utcnow
from app.models import IngestionJob, JobStatus
from app.queue.events import bus
from app.queue.jobs import execute_job

logger = logging.getLogger(__name__)

QUEUE_KEY = "pia:jobs"
PROCESSING_PREFIX = "pia:jobs:processing:"
WORKER_PREFIX = "pia:worker:"


class JobRunner(Protocol):
    async def enqueue(self, job_id: str) -> None: ...

    async def cancel(self, job_id: str) -> None: ...

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def drain(self) -> None: ...

    async def stats(self) -> dict[str, Any]: ...


# --- shared persistence logic (DB is the source of truth; queues only wake workers) -------------


async def requeue_stale_jobs(runner: JobRunner, *, stale_seconds: int | None = None, startup: bool = False) -> int:
    """Re-enqueue jobs that lost their worker (crash, restart, lost queue message).

    * ``processing`` with a stale heartbeat → back to ``accepted`` (attempts are bounded when claimed)
    * ``accepted`` and older than the threshold → pushed again (duplicates are harmless: claims are atomic)
    With ``startup=True`` (single-instance in-process mode) every unfinished job is recovered at once.
    """
    s = get_settings()
    stale = s.job_stale_seconds if stale_seconds is None else stale_seconds
    cutoff = utcnow() - timedelta(seconds=stale)
    n = 0
    async with SessionLocal() as session:
        cond_processing = IngestionJob.status == JobStatus.processing.value
        cond_accepted = IngestionJob.status == JobStatus.accepted.value
        if not startup:
            cond_processing = cond_processing & (IngestionJob.updated_at < cutoff)
            cond_accepted = cond_accepted & (IngestionJob.updated_at < cutoff)
        rows = (await session.execute(select(IngestionJob.id, IngestionJob.status).where(cond_processing | cond_accepted))).all()
        to_push: list[str] = []
        for jid, status in rows:
            # Claim the re-push atomically (compare-and-set on status + updated_at): several reapers may
            # run at once and a backlog must not be pushed again on every pass, or the queue would
            # grow without bound while workers are busy.
            guard = (IngestionJob.id == jid) & (IngestionJob.status == status)
            if not startup:
                guard = guard & (IngestionJob.updated_at < cutoff)
            res = await session.execute(
                update(IngestionJob).where(guard).values(status=JobStatus.accepted.value, updated_at=utcnow())
            )
            if res.rowcount == 1:  # type: ignore[attr-defined]
                to_push.append(jid)
        await session.commit()
    for jid in to_push:
        await runner.enqueue(jid)
        n += 1
    if n:
        logger.warning("re-queued %d unfinished job(s)", n)
    return n


class InProcessRunner:
    """Background job runner backed by asyncio tasks (single process).

    Unfinished jobs survive restarts: they live in the database and are re-queued at startup.
    For several replicas use RedisRunner.
    """

    def __init__(self, concurrency: int = 4) -> None:
        self._sem = asyncio.Semaphore(max(1, concurrency))
        self._tasks: dict[str, asyncio.Task] = {}
        bus.on_cancel(self._cancel_local)

    async def enqueue(self, job_id: str) -> None:
        if job_id in self._tasks:
            return
        task = asyncio.create_task(self._run(job_id))
        self._tasks[job_id] = task
        task.add_done_callback(lambda _t: self._tasks.pop(job_id, None))

    async def _run(self, job_id: str) -> None:
        async with self._sem:
            try:
                await execute_job(job_id)
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("job %s crashed", job_id)

    def _cancel_local(self, job_id: str) -> None:
        task = self._tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()

    async def cancel(self, job_id: str) -> None:
        await bus.request_cancel(job_id)

    async def start(self) -> None:
        s = get_settings()
        if s.message_mode == "queue" and s.recover_jobs_on_start:
            await requeue_stale_jobs(self, startup=True)

    async def stop(self) -> None:
        for t in list(self._tasks.values()):
            t.cancel()
        await self.drain()

    async def drain(self) -> None:
        """Wait for all queued jobs (used by tests/shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks.values()), return_exceptions=True)

    async def stats(self) -> dict[str, Any]:
        return {"backend": "inprocess", "running": len(self._tasks)}


class RedisRunner:
    """Multi-replica runner: Redis list = wake-up queue, database = durable state.

    * enqueue → LPUSH; consumers BLMOVE into a per-worker processing list (reliable queue)
    * a job is *claimed* atomically in the DB, so duplicates/re-deliveries never run twice
    * running jobs heartbeat ``updated_at``; a reaper re-queues jobs whose worker died
    * cancel travels over Redis pub/sub to whichever worker runs the job
    Run dedicated workers with ``python -m app.worker`` (set EMBEDDED_WORKER=false on API pods).
    """

    def __init__(self, redis: Any, concurrency: int = 4, consume: bool = True) -> None:
        self.redis = redis
        self.concurrency = max(1, concurrency)
        self.consume = consume
        self.worker_id = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
        self._tasks: dict[str, asyncio.Task] = {}
        self._loops: list[asyncio.Task] = []
        self._stopping = asyncio.Event()
        bus.on_cancel(self._cancel_local)

    @property
    def _processing_key(self) -> str:
        return PROCESSING_PREFIX + self.worker_id

    async def enqueue(self, job_id: str) -> None:
        await self.redis.lpush(QUEUE_KEY, job_id)

    def _cancel_local(self, job_id: str) -> None:
        task = self._tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()

    async def cancel(self, job_id: str) -> None:
        await bus.request_cancel(job_id)

    async def start(self) -> None:
        await bus.attach_redis(self.redis)
        self._stopping.clear()
        s = get_settings()
        if self.consume:
            for i in range(self.concurrency):
                self._loops.append(asyncio.create_task(self._consume_loop(i)))
            self._loops.append(asyncio.create_task(self._heartbeat_loop()))
            self._loops.append(asyncio.create_task(self._reaper_loop()))
            if s.recover_jobs_on_start:
                await requeue_stale_jobs(self)

    async def stop(self, grace: float = 20.0) -> None:
        self._stopping.set()
        if self._tasks:
            _, pending = await asyncio.wait(list(self._tasks.values()), timeout=grace)
            for t in pending:  # left as `processing`; the reaper of another worker re-queues them
                t.cancel()
        for t in self._loops:
            t.cancel()
        await asyncio.gather(*self._loops, return_exceptions=True)
        self._loops.clear()
        try:
            await self.redis.delete(WORKER_PREFIX + self.worker_id)
        except Exception:  # noqa: BLE001
            pass
        await bus.detach_redis()

    async def drain(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks.values()), return_exceptions=True)

    async def _consume_loop(self, idx: int) -> None:
        del idx
        while not self._stopping.is_set():
            try:
                job_id = await self.redis.blmove(QUEUE_KEY, self._processing_key, 1, "RIGHT", "LEFT")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("redis consume error: %s", exc)
                await asyncio.sleep(1.0)
                continue
            if not job_id:
                await asyncio.sleep(0.01)  # yield even for transports that return immediately
                continue
            if isinstance(job_id, bytes):
                job_id = job_id.decode()
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
            try:
                await task
            except asyncio.CancelledError:
                if not task.done():  # loop itself was cancelled (shutdown)
                    task.cancel()
                    raise
            finally:
                self._tasks.pop(job_id, None)
                try:
                    await self.redis.lrem(self._processing_key, 1, job_id)
                except Exception:  # noqa: BLE001
                    pass

    async def _run(self, job_id: str) -> None:
        try:
            await execute_job(job_id)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("job %s crashed", job_id)

    async def _heartbeat_loop(self) -> None:
        s = get_settings()
        interval = max(1.0, s.job_stale_seconds / 3)
        while True:
            try:
                await self.redis.set(WORKER_PREFIX + self.worker_id, "1", ex=int(s.job_stale_seconds))
                if self._tasks:
                    async with SessionLocal() as session:
                        await session.execute(
                            update(IngestionJob)
                            .where(IngestionJob.id.in_(list(self._tasks)))
                            .where(IngestionJob.status == JobStatus.processing.value)
                            .values(updated_at=utcnow())
                        )
                        await session.commit()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("heartbeat failed: %s", exc)
            await asyncio.sleep(interval)

    async def _reaper_loop(self) -> None:
        s = get_settings()
        interval = max(2.0, s.job_stale_seconds / 2)
        while True:
            await asyncio.sleep(interval)
            try:
                await requeue_stale_jobs(self)
                await self._collect_dead_worker_lists()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("reaper failed: %s", exc)

    async def _collect_dead_worker_lists(self) -> None:
        async for key in self.redis.scan_iter(match=PROCESSING_PREFIX + "*"):
            key = key.decode() if isinstance(key, bytes) else key
            wid = key[len(PROCESSING_PREFIX) :]
            if wid == self.worker_id or await self.redis.exists(WORKER_PREFIX + wid):
                continue
            await self.redis.delete(key)  # jobs are recovered from the DB by requeue_stale_jobs

    async def stats(self) -> dict[str, Any]:
        try:
            queued = int(await self.redis.llen(QUEUE_KEY))
        except Exception:  # noqa: BLE001
            queued = -1
        return {"backend": "redis", "queued": queued, "running_here": len(self._tasks), "worker_id": self.worker_id}


_runner: JobRunner | None = None


def get_runner() -> JobRunner:
    global _runner
    if _runner is None:
        s = get_settings()
        if s.queue_backend == "redis" and s.redis_url:
            from app.queue.redis_client import get_redis

            _runner = RedisRunner(get_redis(), concurrency=s.queue_concurrency, consume=s.embedded_worker)
        else:
            _runner = InProcessRunner(concurrency=s.queue_concurrency)
    return _runner


def set_runner(runner: JobRunner | None) -> None:
    global _runner
    _runner = runner
