"""Apply the CURRENT separate deletion journal to an OFFLINE restored database before reopening it."""
from __future__ import annotations

import argparse
import asyncio
import uuid
from pathlib import Path

from sqlalchemy import update

from app.db import SessionLocal
from app.models import IngestionJob, User
from app.services.account import cleanup_deleted_blobs, delete_account


async def apply_journal(path: Path) -> int:
    ids = {str(uuid.UUID(line.strip())) for line in path.read_text().splitlines() if line.strip()}
    count = 0
    async with SessionLocal() as session:
        for user_id in ids:
            user = await session.get(User, user_id)
            if user is None:
                continue
            await session.execute(update(IngestionJob).where(IngestionJob.user_id == user_id).values(status='cancelled'))
            await delete_account(session, user)
            count += 1
    await cleanup_deleted_blobs()
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--journal', required=True, type=Path)
    parser.add_argument('--writers-stopped', action='store_true')
    args = parser.parse_args()
    if not args.writers_stopped:
        parser.error('Stop all API/worker writers before applying the journal')
    print(f'Reapplied {asyncio.run(apply_journal(args.journal))} account deletions')


if __name__ == '__main__':
    main()
