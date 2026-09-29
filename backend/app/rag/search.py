from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunk, Entity, Observation

logger = logging.getLogger(__name__)

# Caps keep in-process cosine search acceptable at personal-KB scale.
MAX_VECTOR_CANDIDATES = 5000
DEFAULT_TOP_K = 8


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


async def _query_embedding(session: AsyncSession, user_id: str, query: str) -> list[float] | None:
    try:
        from app.config import get_settings
        from app.llm.router import provider_for_user
        from app.models import LLMSettings

        provider = await provider_for_user(session, user_id)
        row = await session.get(LLMSettings, user_id)
        emb_model = (row.embedding_model if row else None) or get_settings().default_embedding_model
        vecs = await provider.embed([query], model=emb_model)
        return vecs[0] if vecs else None
    except Exception as exc:  # noqa: BLE001 — degrade to text search
        logger.info("query embedding unavailable (user=%s): %s", user_id, exc)
        return None


async def _vector_hits(
    session: AsyncSession, user_id: str, query_vec: list[float], k: int
) -> list[dict[str, Any]]:
    res = await session.execute(
        select(Chunk)
        .where(Chunk.user_id == user_id)
        .where(Chunk.embedding.is_not(None))
        .order_by(Chunk.created_at.desc())
        .limit(MAX_VECTOR_CANDIDATES)
    )
    scored: list[tuple[float, Chunk]] = []
    for ch in res.scalars().all():
        if not isinstance(ch.embedding, list):
            continue
        score = cosine_similarity(query_vec, ch.embedding)
        if score > 0:
            scored.append((score, ch))
    scored.sort(key=lambda p: p[0], reverse=True)
    return [
        {
            "kind": "chunk",
            "id": ch.id,
            "entity_id": ch.entity_id,
            "text": ch.text,
            "score": round(score, 4),
            "source": "vector",
        }
        for score, ch in scored[:k]
    ]


async def _text_hits(session: AsyncSession, user_id: str, query: str, k: int) -> list[dict[str, Any]]:
    like = f"%{query}%"
    out: list[dict[str, Any]] = []
    res = await session.execute(
        select(Entity).where(Entity.user_id == user_id).where(cast(Entity.payload, String).ilike(like))
    )
    for e in list(res.scalars().all())[:k]:
        out.append(
            {"kind": "entity", "id": e.id, "domain": e.domain, "payload": e.payload, "source": "text"}
        )
    res2 = await session.execute(
        select(Observation)
        .where(Observation.user_id == user_id)
        .where(cast(Observation.payload, String).ilike(like))
    )
    for o in list(res2.scalars().all())[:k]:
        out.append(
            {
                "kind": "observation",
                "id": o.id,
                "entity_id": o.entity_id,
                "payload": o.payload,
                "source": "text",
            }
        )
    return out


async def hybrid_search(
    session: AsyncSession,
    user_id: str,
    query: str,
    k: int = DEFAULT_TOP_K,
) -> list[dict[str, Any]]:
    """Hybrid retrieval: semantic (embeddings) + substring over KB JSON payloads.

    Embeddings are stored as JSON so the same code runs on SQLite and Postgres;
    at personal-KB scale cosine is computed in-process. Swap in pgvector later
    without changing call sites.
    """
    query = query.strip()
    if not query:
        return []
    vector: list[dict[str, Any]] = []
    query_vec = await _query_embedding(session, user_id, query)
    if query_vec is not None:
        vector = await _vector_hits(session, user_id, query_vec, k)
    text = await _text_hits(session, user_id, query, k)
    # Merge: vector hits first (dedupe by id), then text-only hits.
    seen = {h["id"] for h in vector}
    merged = list(vector)
    merged.extend(h for h in text if h["id"] not in seen)
    return merged[: k * 2]
