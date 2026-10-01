from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import Select, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Chunk, Entity, Observation
from app.rag.identity import embedding_space

logger = logging.getLogger(__name__)

# Cap for the portable in-process cosine path (SQLite, or vectors whose width != PGVECTOR_DIMENSIONS).
MAX_VECTOR_CANDIDATES = 5000
DEFAULT_TOP_K = 8
RRF_K = 60  # reciprocal-rank-fusion constant
MAX_QUERY_TERMS = 8

_WORD = re.compile(r"[\w\-]{2,}", re.UNICODE)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def query_terms(query: str) -> list[str]:
    """Lower-cased distinct words (max MAX_QUERY_TERMS); the whole phrase counts as a term too."""
    q = query.strip().lower()
    seen: dict[str, None] = {}
    if q:
        seen[q] = None
    for w in _WORD.findall(q):
        seen.setdefault(w, None)
    return list(seen)[:MAX_QUERY_TERMS]


def _like_escape(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def _query_embedding(session: AsyncSession, user_id: str, query: str) -> list[float] | None:
    try:
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


def _chunk_row(ch: Chunk, score: float, source: str) -> dict[str, Any]:
    return {
        "kind": "chunk",
        "id": ch.id,
        "entity_id": ch.entity_id,
        "observation_id": ch.observation_id,
        "text": ch.text,
        "score": round(score, 4),
        "source": source,
    }


async def _pg_vector_hits(
    session: AsyncSession, user_id: str, query_vec: list[float], k: int
) -> list[dict[str, Any]]:
    """Native pgvector cosine ANN (HNSW) restricted to the user's rows."""
    space = await embedding_space(session, user_id)
    dist = Chunk.embedding_vec.cosine_distance(query_vec)

    def stmt() -> Select:
        return (
            select(Chunk, (1 - dist).label("score"))
            .where(Chunk.user_id == user_id)
            .where(Chunk.embedding_vec.is_not(None))
            .where(Chunk.embedding_space == space)
            .order_by(dist)
            .limit(k)
        )

    # Multi-tenant filtering happens after the HNSW scan: widen the candidate list, and use
    # iterative scans when the extension supports them (pgvector >= 0.8; ignored otherwise).
    for guc, val in (("hnsw.ef_search", str(max(100, k * 10))), ("hnsw.iterative_scan", "relaxed_order")):
        try:
            async with session.begin_nested():
                await session.execute(text("SELECT set_config(:k, :v, true)"), {"k": guc, "v": val})
        except Exception:  # noqa: BLE001
            logger.debug("GUC %s unsupported", guc)
    rows = (await session.execute(stmt())).all()
    if len(rows) < k:
        # Index returned fewer than requested (filter starvation): exact scan over this user's rows.
        try:
            async with session.begin_nested():
                await session.execute(text("SELECT set_config('enable_indexscan', 'off', true)"))
                rows = (await session.execute(stmt())).all()
                await session.execute(text("SELECT set_config('enable_indexscan', 'on', true)"))
        except Exception:  # noqa: BLE001
            logger.debug("exact pgvector fallback failed", exc_info=True)
    return [_chunk_row(ch, float(score), "vector") for ch, score in rows if score is not None and score > 0]


async def _json_vector_hits(
    session: AsyncSession, user_id: str, query_vec: list[float], k: int
) -> list[dict[str, Any]]:
    """Portable path: cosine in Python over JSON embeddings (SQLite / odd widths)."""
    space = await embedding_space(session, user_id)
    res = await session.execute(
        select(Chunk)
        .where(Chunk.user_id == user_id)
        .where(Chunk.embedding_space == space)
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
    return [_chunk_row(ch, score, "vector") for score, ch in scored[:k]]


async def _vector_hits(
    session: AsyncSession, user_id: str, query_vec: list[float], k: int
) -> list[dict[str, Any]]:
    from app.db import USE_PGVECTOR

    hits: list[dict[str, Any]] = []
    if USE_PGVECTOR and len(query_vec) == get_settings().pgvector_dimensions:
        hits = await _pg_vector_hits(session, user_id, query_vec, k)
    # JSON-stored vectors (other widths / pre-migration rows) are still searchable.
    json_hits = await _json_vector_hits(session, user_id, query_vec, k)
    if json_hits:
        hits = sorted([*hits, *json_hits], key=lambda h: h["score"], reverse=True)[:k]
    return hits


async def _text_hits(session: AsyncSession, user_id: str, query: str, k: int) -> list[dict[str, Any]]:
    """Substring/term match on indexed chunk text (trigram-indexed on Postgres)."""
    terms = query_terms(query)
    if not terms:
        return []
    conds = [Chunk.text.ilike(f"%{_like_escape(t)}%", escape="\\") for t in terms]
    res = await session.execute(
        select(Chunk)
        .where(Chunk.user_id == user_id)
        .where(or_(*conds))
        .order_by(Chunk.created_at.desc())
        .limit(max(k * 5, 50))
    )
    scored: list[tuple[float, Chunk]] = []
    for ch in res.scalars().all():
        low = ch.text.lower()
        matched = sum(1 for t in terms if t in low)
        scored.append((matched / len(terms), ch))
    scored.sort(key=lambda p: p[0], reverse=True)
    return [_chunk_row(ch, score, "text") for score, ch in scored[:k]]


async def _hydrate(session: AsyncSession, user_id: str, hits: list[dict[str, Any]]) -> None:
    """Attach the source record (payload/domain) so the agent sees structured data, not just a snippet."""
    ent_ids = {h["entity_id"] for h in hits if h.get("entity_id")}
    obs_ids = {h["observation_id"] for h in hits if h.get("observation_id")}
    entities: dict[str, Entity] = {}
    observations: dict[str, Observation] = {}
    if ent_ids:
        res = await session.execute(select(Entity).where(Entity.user_id == user_id).where(Entity.id.in_(ent_ids)))
        entities = {e.id: e for e in res.scalars()}
    if obs_ids:
        res2 = await session.execute(
            select(Observation).where(Observation.user_id == user_id).where(Observation.id.in_(obs_ids))
        )
        observations = {o.id: o for o in res2.scalars()}
    for h in hits:
        obs = observations.get(h.get("observation_id") or "")
        ent = entities.get(h.get("entity_id") or "")
        if obs is not None:
            h["record"] = "observation"
            h["payload"] = obs.payload
            h["occurred_at"] = obs.occurred_at.isoformat() if obs.occurred_at else None
        elif ent is not None:
            h["record"] = "entity"
            h["payload"] = ent.payload
        if ent is not None:
            h["domain"] = ent.domain


def fuse(vector: list[dict[str, Any]], text_hits: list[dict[str, Any]], k: int) -> list[dict[str, Any]]:
    """Reciprocal rank fusion. A chunk found by both lists keeps source='vector' and gains matched_by."""
    fused: dict[str, dict[str, Any]] = {}
    rrf: dict[str, float] = {}
    for source, hits in (("vector", vector), ("text", text_hits)):
        for rank, h in enumerate(hits):
            cid = h["id"]
            rrf[cid] = rrf.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
            if cid not in fused:
                fused[cid] = {**h, "matched_by": [source]}
            else:
                fused[cid]["matched_by"].append(source)
    ordered = sorted(fused, key=lambda cid: rrf[cid], reverse=True)
    return [fused[cid] for cid in ordered[:k]]


async def hybrid_search(
    session: AsyncSession,
    user_id: str,
    query: str,
    k: int = DEFAULT_TOP_K,
) -> list[dict[str, Any]]:
    """Hybrid retrieval over indexed chunks: semantic (pgvector HNSW on Postgres, cosine in
    Python on SQLite) + term match (trigram GIN on Postgres), merged with reciprocal rank
    fusion. Degrades to text-only when the embedding backend is down."""
    query = query.strip()
    if not query:
        return []
    vector: list[dict[str, Any]] = []
    query_vec = await _query_embedding(session, user_id, query)
    if query_vec is not None:
        vector = await _vector_hits(session, user_id, query_vec, k)
    text_hits = await _text_hits(session, user_id, query, k)
    merged = fuse(vector, text_hits, k)
    await _hydrate(session, user_id, merged)
    return merged
