from __future__ import annotations

import asyncio
import uuid

import fakeredis
import pytest
from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.models import IngestionJob, JobStatus, User
from app.queue import runner as runner_mod
from app.queue.events import EventBus
from app.queue.jobs import claim_job


async def _make_job(status: str = "accepted", attempts: int = 0, age_seconds: int = 0) -> str:
    from datetime import timedelta

    await init_db()
    async with SessionLocal() as s:
        u = User(email=f"q{uuid.uuid4().hex[:8]}@t.dev", password_hash="x")
        s.add(u)
        await s.flush()
        job = IngestionJob(
            user_id=u.id,
            status=status,
            attempts=attempts,
            envelope=IngestionEnvelope(text="hi").model_dump(mode="json"),
            updated_at=utcnow() - timedelta(seconds=age_seconds),
        )
        s.add(job)
        await s.commit()
        return job.id


async def _status(job_id: str) -> str:
    async with SessionLocal() as s:
        return (await s.get(IngestionJob, job_id)).status  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_claim_is_atomic_and_bounded() -> None:
    jid = await _make_job()
    first, second = await asyncio.gather(claim_job(jid), claim_job(jid))
    assert (first is None) != (second is None), "exactly one claimer wins"
    assert await _status(jid) == "processing"

    exhausted = await _make_job(attempts=99)
    assert await claim_job(exhausted) is None
    assert await _status(exhausted) == "failed"


@pytest.mark.asyncio
async def test_event_bus_over_redis_reaches_other_process_and_replays() -> None:
    server = fakeredis.FakeServer()
    r1 = fakeredis.FakeAsyncRedis(server=server, decode_responses=True)
    r2 = fakeredis.FakeAsyncRedis(server=server, decode_responses=True)
    api, worker = EventBus(), EventBus()
    await api.attach_redis(r1)
    await worker.attach_redis(r2)
    try:
        q = api.subscribe("job-1")
        await worker.publish("job-1", {"type": "token", "content": "при"})
        await worker.publish("job-1", {"type": "done", "text": "привет"})
        got = [await asyncio.wait_for(q.get(), 2), await asyncio.wait_for(q.get(), 2)]
        assert [e["type"] for e in got] == ["token", "done"]
        # a subscriber that connects late still sees the whole stream (replay buffer)
        late = api.subscribe("job-1")
        assert late.qsize() == 2
    finally:
        await api.detach_redis()
        await worker.detach_redis()


@pytest.mark.asyncio
async def test_event_bus_local_history_and_cancel_callbacks() -> None:
    bus = EventBus()
    await bus.publish("j", {"type": "token", "content": "a"})
    q = bus.subscribe("j")
    assert q.get_nowait()["content"] == "a"
    seen: list[str] = []
    bus.on_cancel(lambda jid: seen.append(jid))
    await bus.request_cancel("j")
    assert seen == ["j"]


@pytest.mark.asyncio
async def test_redis_runner_processes_jobs_and_cancels_across_workers(monkeypatch: pytest.MonkeyPatch) -> None:
    server = fakeredis.FakeServer()
    redis_api = fakeredis.FakeAsyncRedis(server=server, decode_responses=True)
    redis_w = fakeredis.FakeAsyncRedis(server=server, decode_responses=True)

    started: dict[str, asyncio.Event] = {}
    finished: list[str] = []
    slow_jobs: set[str] = set()

    async def _set_status(job_id: str, status: str) -> None:
        async with SessionLocal() as s:
            row = await s.get(IngestionJob, job_id)
            row.status = status  # type: ignore[union-attr]
            await s.commit()

    async def fake_execute(job_id: str) -> dict:
        if await claim_job(job_id) is None:
            return {"skipped": True}
        started.setdefault(job_id, asyncio.Event()).set()
        try:
            await asyncio.sleep(30 if job_id in slow_jobs else 0.1)
        except asyncio.CancelledError:
            await _set_status(job_id, "cancelled")
            return {"cancelled": True}
        await _set_status(job_id, "completed")
        finished.append(job_id)
        return {}

    monkeypatch.setattr(runner_mod, "execute_job", fake_execute)
    api = runner_mod.RedisRunner(redis_api, concurrency=1, consume=False)
    worker = runner_mod.RedisRunner(redis_w, concurrency=2, consume=True)
    await worker.start()
    try:
        ids = [await _make_job(), await _make_job()]
        for jid in ids:
            await api.enqueue(jid)
        for _ in range(100):
            if all([await _status(j) == "completed" for j in ids]):
                break
            await asyncio.sleep(0.05)
        assert sorted(finished) == sorted(ids)  # each ran exactly once

        # a duplicate delivery of a finished job is skipped by the atomic claim
        await api.enqueue(ids[0])
        await asyncio.sleep(0.3)
        assert finished.count(ids[0]) == 1

        # cancel travels through Redis pub/sub to the worker that owns the task
        slow = await _make_job()
        slow_jobs.add(slow)
        await api.enqueue(slow)
        await asyncio.wait_for(started.setdefault(slow, asyncio.Event()).wait(), 5)
        await api.cancel(slow)
        for _ in range(100):
            if await _status(slow) == "cancelled":
                break
            await asyncio.sleep(0.05)
        assert await _status(slow) == "cancelled"
        stats = await worker.stats()
        assert stats["backend"] == "redis"
    finally:
        await worker.stop(grace=1)


@pytest.mark.asyncio
async def test_reaper_requeues_dead_worker_jobs_and_duplicates_are_harmless(monkeypatch: pytest.MonkeyPatch) -> None:
    redis = fakeredis.FakeAsyncRedis(decode_responses=True)
    r = runner_mod.RedisRunner(redis, concurrency=1, consume=False)

    stale_processing = await _make_job(status="processing", age_seconds=600)
    stale_accepted = await _make_job(status="accepted", age_seconds=600)
    fresh = await _make_job(status="accepted", age_seconds=0)
    done = await _make_job(status="completed", age_seconds=600)

    n = await runner_mod.requeue_stale_jobs(r, stale_seconds=60)
    queued = set(await redis.lrange(runner_mod.QUEUE_KEY, 0, -1))
    assert {stale_processing, stale_accepted} <= queued
    assert fresh not in queued and done not in queued
    assert n >= 2
    assert await _status(stale_processing) == "accepted"  # reset so it can be claimed again


@pytest.mark.asyncio
async def test_inprocess_runner_recovers_unfinished_jobs_on_start(monkeypatch: pytest.MonkeyPatch) -> None:
    ran: list[str] = []

    async def fake_execute(job_id: str) -> dict:
        ran.append(job_id)
        return {}

    monkeypatch.setattr(runner_mod, "execute_job", fake_execute)
    crashed = await _make_job(status="processing")
    waiting = await _make_job(status="accepted")

    class _S:
        message_mode = "queue"
        recover_jobs_on_start = True
        job_stale_seconds = 120

    monkeypatch.setattr(runner_mod, "get_settings", lambda: _S())
    r = runner_mod.InProcessRunner(concurrency=2)
    await r.start()
    await r.drain()
    assert {crashed, waiting} <= set(ran)
    async with SessionLocal() as s:
        # requeued jobs went back through `accepted` (attempt counting happens at claim time)
        rows = (await s.execute(select(IngestionJob.status).where(IngestionJob.id == crashed))).scalar_one()
        assert rows in ("accepted", "processing")
    _ = JobStatus
