"""Run against a real Postgres+pgvector (see tests/test_pgvector.py). Prints OK on success.

Env: DATABASE_URL (postgresql+asyncpg://...). Executed in a subprocess because the engine
is created at import time from the environment.
"""

from __future__ import annotations

import asyncio
import math

from sqlalchemy import select, text

from app.config import get_settings
from app.db import USE_PGVECTOR, SessionLocal, engine, init_db
from app.models import Chunk, Collection, Entity, ExtractedFact, Observation, User
from app.rag.indexing import _index_texts, backfill_vectors
from app.rag.search import hybrid_search
from app.services.facts import FactError, resolve_fact

DIMS = get_settings().pgvector_dimensions


def vec(axis: int, dims: int = DIMS) -> list[float]:
    v = [0.0] * dims
    v[axis] = 1.0
    return v


def blend(a: int, b: int, w: float = 0.2) -> list[float]:
    v = [0.0] * DIMS
    v[a], v[b] = math.sqrt(1 - w * w), w
    return v


class FakeProvider:
    """Embeds by keyword → axis; unknown → axis 7."""

    AX = {"camry": 0, "oil": 1, "glucose": 2}

    async def embed(self, texts, *, model):
        out = []
        for t in texts:
            low = t.lower()
            ax = next((i for k, i in self.AX.items() if k in low), 7)
            out.append(vec(ax))
        return out


async def main() -> None:
    assert USE_PGVECTOR, "pgvector must be active"
    # every replica/worker calls init_db() at startup: concurrent first boot must not race on DDL
    await asyncio.gather(*[init_db() for _ in range(6)])
    async with engine.begin() as conn:
        # indexes created by create_all DDL hooks
        idx = (await conn.execute(text("select indexname from pg_indexes where tablename='chunks'"))).scalars().all()
        assert "ix_chunks_embedding_hnsw" in idx, idx
        # ix_chunks_text_trgm exists only where the pg_trgm contrib extension is installed

    import app.rag.indexing as indexing
    import app.rag.search as search_mod

    prov = FakeProvider()

    async def _p(session, user_id, settings=None):
        return prov

    import app.llm.router as router

    indexing.provider_for_user = _p  # type: ignore[assignment]
    router.provider_for_user = _p  # type: ignore[assignment]

    async with SessionLocal() as s:
        u1 = User(email="pg1@test.dev", password_hash="x")
        u2 = User(email="pg2@test.dev", password_hash="x")
        s.add_all([u1, u2])
        await s.flush()
        s.add(Collection(user_id=u1.id, name="G", slug="garage"))
        await s.commit()
        uid1, uid2 = u1.id, u2.id

    async with SessionLocal() as s:
        await _index_texts(s, uid1, ["Toyota Camry 2020 owner notes"])
        await _index_texts(s, uid1, ["Engine oil change at 90000 km"])
        await _index_texts(s, uid1, ["Glucose 5.4 mmol/l"])
        # noise from another tenant, closer to the query than user1's rows
        for i in range(60):
            await _index_texts(s, uid2, [f"Camry other tenant {i}"])
        await s.commit()

    async with SessionLocal() as s:
        flags = (
            await s.execute(
                select(Chunk.embedding_vec.is_not(None), Chunk.embedding.is_(None)).where(Chunk.user_id == uid1)
            )
        ).all()
        assert flags and all(a and b for a, b in flags), "stored natively"
        hits = await hybrid_search(s, uid1, "camry", k=3)
        assert hits, hits
        assert hits[0]["source"] == "vector" and hits[0]["score"] > 0.99, hits[0]
        assert "Camry" in hits[0]["text"]
        # tenant isolation
        assert all("other tenant" not in h["text"] for h in hits)
        # exact-scan fallback: user1 has 3 rows, k larger than that still returns all (post-filter starvation)
        many = await hybrid_search(s, uid1, "oil", k=3)
        assert any("oil" in h["text"].lower() for h in many)
        # text-only path (unknown word → vector axis 7, still finds substring)
        t = await hybrid_search(s, uid1, "mmol", k=3)
        assert any("Glucose" in h["text"] for h in t), t

        # width mismatch is stored in JSON and still searchable
        class Short:
            async def embed(self, texts, *, model):
                return [[1.0, 0.0, 0.0] for _ in texts]

        indexing.provider_for_user = lambda *a, **k: _async(Short())  # type: ignore[assignment]
        await _index_texts(s, uid1, ["short vector doc"])
        await s.commit()
        emb, has_vec = (
            await s.execute(select(Chunk.embedding, Chunk.embedding_vec.is_not(None)).where(Chunk.text == "short vector doc"))
        ).one()
        assert emb == [1.0, 0.0, 0.0] and not has_vec
        assert any("short vector" in h["text"] for h in await hybrid_search(s, uid1, "short", k=3))

    # legacy JSON embeddings of the right width are moved into the native column; other widths stay
    async with SessionLocal() as s:
        s.add_all(
            [
                Chunk(user_id=uid1, text="legacy json full width", embedding=vec(4)),
                Chunk(user_id=uid1, text="legacy json other width", embedding=[0.5, 0.5]),
            ]
        )
        await s.commit()
    async with SessionLocal() as s:
        assert await backfill_vectors(s) == 1
        await s.commit()
        rows = dict(
            (
                await s.execute(
                    select(Chunk.text, Chunk.embedding_vec.is_not(None)).where(Chunk.text.like("legacy json%"))
                )
            ).all()
        )
        assert rows == {"legacy json full width": True, "legacy json other width": False}, rows
        assert await backfill_vectors(s) == 0  # idempotent

    # two simultaneous confirmations of one fact (web + Telegram): exactly one observation is created
    async with SessionLocal() as s:
        coll = (await s.execute(select(Collection).where(Collection.user_id == uid1))).scalars().first()
        assert coll is not None
        ent = Entity(user_id=uid1, collection_id=coll.id, domain="automotive", schema_version="1", payload={"type": "vehicle"})
        s.add(ent)
        await s.flush()
        fact = ExtractedFact(
            user_id=uid1, entity_id=ent.id, payload={"kind": "service_event", "summary": "oil", "observation": {"a": 1}}
        )
        s.add(fact)
        await s.commit()
        fact_id, ent_id = fact.id, ent.id

    async def press() -> str:
        async with SessionLocal() as s2:
            try:
                await resolve_fact(s2, uid1, fact_id, confirm=True)
                await s2.commit()
                return "ok"
            except FactError as exc:
                await s2.rollback()
                return exc.code

    results = await asyncio.gather(*[press() for _ in range(4)])
    assert results.count("ok") == 1, results
    async with SessionLocal() as s:
        n_obs = len((await s.execute(select(Observation.id).where(Observation.entity_id == ent_id))).all())
        assert n_obs == 1, n_obs

    _ = search_mod
    print("OK")
    await engine.dispose()


async def _async(v):
    return v


asyncio.run(main())
