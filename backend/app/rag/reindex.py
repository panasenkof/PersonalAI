"""CLI: backfill / rebuild the search index.  python -m app.rag.reindex [--force]"""

from __future__ import annotations

import asyncio
import sys

from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.models import User
from app.rag.indexing import reindex_user


async def main(force: bool) -> None:
    await init_db()
    async with SessionLocal() as session:
        ids = list((await session.execute(select(User.id))).scalars())
    for uid in ids:
        async with SessionLocal() as session:
            stats = await reindex_user(session, uid, force=force)
            await session.commit()
        print(f"user={uid} reindexed {stats}")


if __name__ == "__main__":
    asyncio.run(main("--force" in sys.argv))
