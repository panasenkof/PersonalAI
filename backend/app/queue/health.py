"""Container health probe for a dedicated worker's Redis heartbeat."""
import asyncio
from pathlib import Path

from app.config import get_settings
from app.queue.redis_client import close_redis, get_redis
from app.queue.runner import WORKER_PREFIX


async def main() -> None:
    try:
        worker_id = Path("/tmp/pia-worker-id").read_text().strip()
        if not worker_id or not get_settings().redis_url:
            raise SystemExit(1)
        healthy = await asyncio.wait_for(get_redis().exists(WORKER_PREFIX + worker_id), timeout=4)
        if not healthy:
            raise SystemExit(1)
    finally:
        await close_redis()


if __name__ == "__main__":
    asyncio.run(main())
