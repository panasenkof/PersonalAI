from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.universal_tools import kb_create_entity, kb_search
from app.llm.providers import ChatMessage, LLMCompletionResult
from app.models import Base, Chunk, Collection, User
from app.rag.indexing import split_text
from app.rag.search import cosine_similarity, hybrid_search


class FakeEmbedProvider:
    """Deterministic embeddings: 'camry' → axis 0, 'oil' → axis 1, other → axis 2."""

    def __init__(self, fail: bool = False):
        self.fail = fail

    def _vec(self, text: str) -> list[float]:
        t = text.lower()
        return [
            1.0 if "camry" in t else 0.0,
            1.0 if "oil" in t else 0.0,
        ]

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        if self.fail:
            raise RuntimeError("no embedding backend")
        return [self._vec(t) for t in texts]

    async def chat(self, messages, *, model, tools=None, tool_choice=None, temperature=0.2):
        return LLMCompletionResult(message=ChatMessage(role="assistant", content="ok"), raw={})


def test_cosine_similarity() -> None:
    assert cosine_similarity([1, 0], [1, 0]) == pytest.approx(1.0)
    assert cosine_similarity([1, 0], [0, 1]) == pytest.approx(0.0)
    assert cosine_similarity([], [1]) == 0.0
    assert cosine_similarity([1, 1], [0, 0]) == 0.0


def test_split_text_chunks() -> None:
    assert split_text("short") == ["short"]
    assert split_text("") == []
    long = "x" * 2500
    parts = split_text(long)
    assert len(parts) >= 3
    assert all(len(p) <= 800 for p in parts)
    assert "".join(parts)[:2500] == long or len("".join(parts)) >= 2000


async def _setup(monkeypatch: pytest.MonkeyPatch, fail_embed: bool = False):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    fake = FakeEmbedProvider(fail=fail_embed)
    monkeypatch.setattr("app.rag.indexing.provider_for_user", lambda s, u, settings=None: _async(fake))
    monkeypatch.setattr("app.llm.router.provider_for_user", lambda s, u, settings=None: _async(fake))
    return Session, fake


async def _async(value):
    return value


@pytest.mark.asyncio
async def test_entity_indexing_and_hybrid_search(monkeypatch: pytest.MonkeyPatch) -> None:
    Session, _ = await _setup(monkeypatch)
    async with Session() as session:
        u = User(email="r@test.dev", password_hash="x")
        session.add(u)
        await session.flush()
        session.add(Collection(user_id=u.id, name="Garage", slug="garage"))
        await session.commit()

    async with Session() as session:
        out = await kb_create_entity(
            session,
            u.id,
            {
                "collection_slug": "garage",
                "domain": "automotive",
                "payload": {"type": "vehicle", "make": "Toyota", "model": "Camry", "year": 2020},
            },
        )
        await session.commit()
        assert out["status"] == "created"

    # chunk was indexed with an embedding
    async with Session() as session:
        chunks = list((await session.execute(select(Chunk))).scalars().all())
        assert chunks and chunks[0].embedding is not None

    async with Session() as session:
        # semantic hit: query shares "camry" axis
        hits = await hybrid_search(session, u.id, "camry", k=5)
        assert hits, "expected hits"
        vector_hits = [h for h in hits if h.get("source") == "vector"]
        assert vector_hits and vector_hits[0]["score"] > 0.5
        # and the kb_search tool routes through hybrid
        tool_hits = await kb_search(session, u.id, {"query": "Toyota Camry"})
        assert tool_hits["hits"]

        # unrelated query on a different axis finds nothing semantic
        other = await hybrid_search(session, u.id, "brake fluid specification", k=5)
        assert all(h.get("source") != "vector" for h in other), other


@pytest.mark.asyncio
async def test_embedding_failure_falls_back_to_text(monkeypatch: pytest.MonkeyPatch) -> None:
    Session, _ = await _setup(monkeypatch, fail_embed=True)
    async with Session() as session:
        u = User(email="f@test.dev", password_hash="x")
        session.add(u)
        await session.flush()
        session.add(Collection(user_id=u.id, name="Garage", slug="garage"))
        await session.commit()
        out = await kb_create_entity(
            session,
            u.id,
            {
                "collection_slug": "garage",
                "domain": "automotive",
                "payload": {"type": "vehicle", "make": "Toyota", "model": "Camry"},
            },
        )
        await session.commit()
        assert out["status"] == "created"

    async with Session() as session:
        chunks = list((await session.execute(select(Chunk))).scalars().all())
        assert chunks and chunks[0].embedding is None
        hits = await hybrid_search(session, u.id, "Camry", k=5)
        assert hits and hits[0]["source"] == "text"
