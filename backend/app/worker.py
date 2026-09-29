"""Dedicated queue worker:  python -m app.worker

Consumes jobs from Redis (QUEUE_BACKEND=redis) so API replicas stay light and workers scale
independently. Several workers can run at once; jobs are claimed atomically in the database.
"""

from __future__ import annotations

import asyncio
import logging
import signal

from app.config import get_settings, production_problems
from app.observability import configure_logging

logger = logging.getLogger("pia.worker")


async def run() -> None:
    settings = get_settings()
    if settings.queue_backend != "redis" or not settings.redis_url:
        raise SystemExit("worker requires QUEUE_BACKEND=redis and REDIS_URL")
    if settings.is_production:
        problems = production_problems(settings)
        if problems:
            raise SystemExit("Refusing to start in production: " + "; ".join(problems))

    from app.db import init_db
    from app.queue.redis_client import close_redis, get_redis
    from app.queue.runner import RedisRunner, set_runner

    await init_db()
    runner = RedisRunner(get_redis(), concurrency=settings.queue_concurrency, consume=True)
    set_runner(runner)
    await runner.start()
    logger.info("worker %s started (concurrency=%d)", runner.worker_id, settings.queue_concurrency)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover (Windows)
            pass
    await stop.wait()
    logger.info("worker shutting down (finishing running jobs)")
    await runner.stop()
    await close_redis()


def main() -> None:
    configure_logging()
    asyncio.run(run())


if __name__ == "__main__":
    main()
