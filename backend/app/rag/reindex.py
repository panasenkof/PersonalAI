"""CLI: backfill / rebuild the search index.  python -m app.rag.reindex [--force]

* JSON embeddings of the configured width are moved into the pgvector column (Postgres);
* entities/observations without chunks are indexed; ``--force`` re-embeds everything
  (use it after changing the embedding model).
"""

from __future__ import annotations

import asyncio
import sys

from sqlalchemy import select

from app.db import SessionLocal, init_db
from app.models import User
from app.rag.indexing import backfill_vectors, reindex_user


async def main(force: bool) -> None:
    await init_db()
    async with SessionLocal() as session:
        moved = await backfill_vectors(session)
        await session.commit()
    if moved:
        print(f"moved {moved} JSON embeddings into the pgvector column")
    async with SessionLocal() as session:
        ids = list((await session.execute(select(User.id))).scalars())
    for uid in ids:
        async with SessionLocal() as session:
            stats = await reindex_user(session, uid, force=force)
            await session.commit()
        print(f"user={uid} reindexed {stats}")


if __name__ == "__main__":
    asyncio.run(main("--force" in sys.argv))
