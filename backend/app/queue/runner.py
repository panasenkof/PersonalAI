from __future__ import annotations

import asyncio
import logging

from app.config import get_settings
from app.queue.jobs import execute_job

logger = logging.getLogger(__name__)


class InProcessRunner:
    """Background job runner backed by asyncio tasks (single-process).

    Decouples LLM latency from the HTTP request cycle; scale-out deployments
    can swap in a Redis/ARQ runner behind the same enqueue() interface.
    """

    def __init__(self, concurrency: int = 4) -> None:
        self._sem = asyncio.Semaphore(max(1, concurrency))
        self._tasks: set[asyncio.Task] = set()

    def enqueue(self, job_id: str) -> None:
        task = asyncio.create_task(self._run(job_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, job_id: str) -> None:
        async with self._sem:
            try:
                await execute_job(job_id)
            except Exception:
                logger.exception("job %s crashed", job_id)

    async def drain(self) -> None:
        """Wait for all queued jobs (used by tests/shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


_runner: InProcessRunner | None = None


def get_runner() -> InProcessRunner:
    global _runner
    if _runner is None:
        _runner = InProcessRunner(concurrency=get_settings().queue_concurrency)
    return _runner
