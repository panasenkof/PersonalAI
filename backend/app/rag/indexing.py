from __future__ import annotations

import logging

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.router import provider_for_user
from app.models import Chunk, Entity, LLMSettings, Observation, utcnow

logger = logging.getLogger(__name__)

CHUNK_SIZE = 800
CHUNK_OVERLAP = 120


def flatten_payload(payload: dict) -> str:
    """Flatten a JSON payload into searchable plain text."""
    parts: list[str] = []

    def walk(v: object) -> None:
        if isinstance(v, dict):
            for vv in v.values():
                walk(vv)
        elif isinstance(v, list):
            for vv in v:
                walk(vv)
        elif v is not None:
            parts.append(str(v))

    walk(payload)
    return " | ".join(parts)


def split_text(text: str) -> list[str]:
    if len(text) <= CHUNK_SIZE:
        return [text] if text.strip() else []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return chunks


async def _embed_texts(session: AsyncSession, user_id: str, texts: list[str]) -> list[list[float]] | None:
    """Return embeddings or None when the embedding backend is unavailable."""
    if not texts:
        return []
    try:
        provider = await provider_for_user(session, user_id)
        row = await session.get(LLMSettings, user_id)
        emb_model = (row.embedding_model if row else None) or get_settings().default_embedding_model
        return await provider.embed(texts, model=emb_model)
    except Exception as exc:  # noqa: BLE001 — indexing must never break the write path
        logger.warning("embedding unavailable for user=%s: %s", user_id, exc)
        return None


def set_chunk_embedding(chunk: Chunk, emb: list[float] | None) -> None:
    """Store an embedding in the native pgvector column when its width fits, else as JSON."""
    from app.db import USE_PGVECTOR

    chunk.embedding = None
    chunk.embedding_vec = None
    if emb is None:
        return
    if USE_PGVECTOR and len(emb) == get_settings().pgvector_dimensions:
        chunk.embedding_vec = emb
    else:
        chunk.embedding = emb


async def _index_texts(
    session: AsyncSession,
    user_id: str,
    texts: list[str],
    *,
    entity_id: str | None = None,
    observation_id: str | None = None,
) -> int:
    chunks = [c for t in texts for c in split_text(t)]
    if not chunks:
        return 0
    embeddings = await _embed_texts(session, user_id, chunks)
    for i, text in enumerate(chunks):
        emb = embeddings[i] if embeddings is not None and i < len(embeddings) else None
        chunk = Chunk(
            user_id=user_id,
            entity_id=entity_id,
            observation_id=observation_id,
            text=text,
            created_at=utcnow(),
        )
        set_chunk_embedding(chunk, emb)
        session.add(chunk)
    await session.flush()
    return len(chunks)


async def index_entity(session: AsyncSession, user_id: str, entity: Entity) -> int:
    text = flatten_payload(entity.payload or {})
    return await _index_texts(session, user_id, [text], entity_id=entity.id)


async def index_observation(session: AsyncSession, user_id: str, observation: Observation) -> int:
    text = flatten_payload(observation.payload or {})
    return await _index_texts(
        session, user_id, [text], entity_id=observation.entity_id, observation_id=observation.id
    )


async def index_text(
    session: AsyncSession, user_id: str, text: str, *, entity_id: str | None = None
) -> int:
    """Index free text (e.g. an ingested document) attached to an entity."""
    return await _index_texts(session, user_id, [text], entity_id=entity_id)


async def reindex_entity(session: AsyncSession, user_id: str, entity: Entity) -> int:
    """Replace the entity's own chunks (observation chunks are untouched) after a payload change."""
    await session.execute(
        delete(Chunk)
        .where(Chunk.user_id == user_id)
        .where(Chunk.entity_id == entity.id)
        .where(Chunk.observation_id.is_(None))
    )
    return await index_entity(session, user_id, entity)


async def reindex_user(session: AsyncSession, user_id: str, *, force: bool = False) -> dict[str, int]:
    """Backfill chunks for entities/observations that have none (legacy rows), or rebuild all with force.

    Used after switching the embedding model or migrating data: ``python -m app.rag.reindex``.
    """
    if force:
        await session.execute(delete(Chunk).where(Chunk.user_id == user_id))
        await session.flush()
    have_entity = set(
        (
            await session.execute(
                select(Chunk.entity_id)
                .where(Chunk.user_id == user_id)
                .where(Chunk.observation_id.is_(None))
                .where(Chunk.entity_id.is_not(None))
            )
        ).scalars()
    )
    have_obs = set(
        (
            await session.execute(
                select(Chunk.observation_id)
                .where(Chunk.user_id == user_id)
                .where(Chunk.observation_id.is_not(None))
            )
        ).scalars()
    )
    n_entities = n_obs = 0
    for e in (await session.execute(select(Entity).where(Entity.user_id == user_id))).scalars():
        if e.id not in have_entity:
            n_entities += 1 if await index_entity(session, user_id, e) else 0
    for o in (await session.execute(select(Observation).where(Observation.user_id == user_id))).scalars():
        if o.id not in have_obs:
            n_obs += 1 if await index_observation(session, user_id, o) else 0
    return {"entities": n_entities, "observations": n_obs}
