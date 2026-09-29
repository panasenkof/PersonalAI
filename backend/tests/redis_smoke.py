"""Smoke test against a REAL Redis (CI service): API-side runner enqueues, a separate worker-side
runner consumes, events cross processes over pub/sub. Not collected by pytest (no test_ prefix).

    REDIS_URL=redis://localhost:6379/0 python -m tests.redis_smoke
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

import redis.asyncio as aioredis


async def main() -> int:
    os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:////tmp/redis_smoke_{uuid.uuid4().hex[:6]}.db")
    os.environ.setdefault("JWT_SECRET", "x" * 32)
    url = os.environ["REDIS_URL"]
    from app.db import SessionLocal, init_db
    from app.ingestion.schemas import IngestionEnvelope
    from app.models import IngestionJob, User
    from app.queue import runner as runner_mod
    from app.queue.events import EventBus
    from app.queue.jobs import claim_job

    await init_db()
    done: list[str] = []

    async def fake_execute(job_id: str) -> dict:
        if await claim_job(job_id) is None:
            return {}
        async with SessionLocal() as s:
            row = await s.get(IngestionJob, job_id)
            row.status = "completed"  # type: ignore[union-attr]
            await s.commit()
        done.append(job_id)
        return {}

    runner_mod.execute_job = fake_execute  # type: ignore[assignment]
    await aioredis.from_url(url).flushdb()
    worker = runner_mod.RedisRunner(aioredis.from_url(url, decode_responses=True), concurrency=2, consume=True)
    api = runner_mod.RedisRunner(aioredis.from_url(url, decode_responses=True), consume=False)
    await worker.start()
    api_bus = EventBus()
    await api_bus.attach_redis(aioredis.from_url(url, decode_responses=True))
    try:
        async with SessionLocal() as s:
            u = User(email=f"s{uuid.uuid4().hex[:6]}@t.dev", password_hash="x")
            s.add(u)
            await s.flush()
            job = IngestionJob(user_id=u.id, status="accepted", envelope=IngestionEnvelope(text="hi").model_dump(mode="json"))
            s.add(job)
            await s.commit()
        q = api_bus.subscribe(job.id)
        await api.enqueue(job.id)
        for _ in range(100):
            if job.id in done:
                break
            await asyncio.sleep(0.1)
        assert job.id in done, "worker did not process the job"
        from app.queue.events import bus as worker_bus

        await worker_bus.publish(job.id, {"type": "token", "content": "x"})
        ev = await asyncio.wait_for(q.get(), 5)
        assert ev["type"] == "token", ev
        print("OK: redis queue + pub/sub")
        return 0
    finally:
        await worker.stop(grace=1)
        await api_bus.detach_redis()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
