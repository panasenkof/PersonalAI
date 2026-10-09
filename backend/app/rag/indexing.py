from __future__ import annotations

import asyncio
import logging

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.llm.router import provider_for_user
from app.memory.contracts import EntityRecord, ObservationRecord
from app.memory.privacy import (
    is_trusted_local_provider,
    remote_blob_processing_allowed,
    remote_embedding_allowed,
)
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


async def _embed_texts(
    session: AsyncSession, user_id: str, texts: list[str], *, collection_id: str | None,
) -> list[list[float]] | None:
    """Return embeddings or None when the embedding backend is unavailable."""
    if not texts:
        return []
    try:
        provider = await provider_for_user(session, user_id)
        if not is_trusted_local_provider(provider) and not await remote_embedding_allowed(
            session, user_id, collection_id,
        ):
            return None
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
    collection_id: str | None = None,
) -> int:
    chunks = [c for t in texts for c in split_text(t)]
    if not chunks:
        return 0
    from app.rag.identity import embedding_space

    space = await embedding_space(session, user_id)
    embeddings = await _embed_texts(session, user_id, chunks, collection_id=collection_id)
    for i, text in enumerate(chunks):
        emb = embeddings[i] if embeddings is not None and i < len(embeddings) else None
        chunk = Chunk(
            user_id=user_id,
            entity_id=entity_id,
            observation_id=observation_id,
            text=text,
            created_at=utcnow(),
        )
        chunk.embedding_space = space if emb is not None else None
        set_chunk_embedding(chunk, emb)
        session.add(chunk)
    await session.flush()
    return len(chunks)


async def index_entity(session: AsyncSession, user_id: str, entity: Entity | EntityRecord) -> int:
    text = flatten_payload(entity.payload or {})
    # A sensitive entity overrides any collection-wide remote embedding consent.
    collection_id = entity.collection_id if entity.sensitivity in {"inherit", "standard"} else None
    # A document entity can include a user-uploaded file. Collection-wide
    # embedding consent alone is insufficient to export the file's text.
    if collection_id and (entity.payload or {}).get("storage_key"):
        from app.models import Collection
        collection = await session.get(Collection, collection_id)
        if collection is None or not await remote_blob_processing_allowed(
            session, user_id, str(entity.payload["storage_key"]), collection.slug,
            embeddings=True,
        ):
            collection_id = None
    return await _index_texts(
        session, user_id, [text], entity_id=entity.id, collection_id=collection_id,
    )


async def index_observation(session: AsyncSession, user_id: str, observation: Observation | ObservationRecord) -> int:
    text = flatten_payload(observation.payload or {})
    entity = await session.scalar(
        select(Entity).where(Entity.id == observation.entity_id, Entity.user_id == user_id)
    )
    collection_id = (
        entity.collection_id
        if entity is not None and entity.sensitivity in {"inherit", "standard"}
        and observation.sensitivity in {"inherit", "standard"} else None
    )
    return await _index_texts(
        session, user_id, [text], entity_id=observation.entity_id,
        observation_id=observation.id, collection_id=collection_id,
    )


async def index_text(
    session: AsyncSession, user_id: str, text: str, *, entity_id: str | None = None
) -> int:
    """Index free text (e.g. an ingested document) attached to an entity."""
    entity = (
        await session.scalar(
            select(Entity).where(Entity.id == entity_id, Entity.user_id == user_id)
        )
        if entity_id else None
    )
    collection_id = (
        entity.collection_id
        if entity is not None and entity.sensitivity in {"inherit", "standard"} else None
    )
    if entity is not None and entity.payload and entity.payload.get("storage_key"):
        from app.models import Collection
        col = await session.get(Collection, collection_id) if collection_id else None
        if col is None or not await remote_blob_processing_allowed(
            session, user_id, str(entity.payload["storage_key"]), col.slug, embeddings=True,
        ):
            collection_id = None
    return await _index_texts(
        session, user_id, [text], entity_id=entity_id, collection_id=collection_id,
    )


async def reindex_entity(session: AsyncSession, user_id: str, entity: Entity) -> int:
    """Replace the entity's own chunks (observation chunks are untouched) after a payload change."""
    await session.execute(
        delete(Chunk)
        .where(Chunk.user_id == user_id)
        .where(Chunk.entity_id == entity.id)
        .where(Chunk.observation_id.is_(None))
    )
    return await _rebuild_entity(session, user_id, entity)


async def _rebuild_entity(session: AsyncSession, user_id: str, entity: Entity) -> int:
    n = await index_entity(session, user_id, entity)
    if entity.domain == "documents" and (entity.payload or {}).get("type") == "document":
        from app.services.blobs import get_blob
        from app.services.documents import extract_document_text
        from app.storage.blob import read_bytes

        key = entity.payload.get("storage_key")
        blob = await get_blob(session, user_id, key) if key else None
        if blob is None:
            raise ValueError("document_source_missing")  # rollback preserves the previous index
        text = await asyncio.to_thread(extract_document_text, await read_bytes(blob.storage_key), blob.mime, blob.filename)
        if not text.strip():
            raise ValueError("document_source_not_extractable")
        n += await index_text(session, user_id, text, entity_id=entity.id)
    return n


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
            n_entities += 1 if await _rebuild_entity(session, user_id, e) else 0
    for o in (await session.execute(select(Observation).where(Observation.user_id == user_id))).scalars():
        if o.id not in have_obs:
            n_obs += 1 if await index_observation(session, user_id, o) else 0
    return {"entities": n_entities, "observations": n_obs}


async def backfill_vectors(session: AsyncSession, batch: int = 500) -> int:
    """Postgres: move JSON embeddings whose width matches PGVECTOR_DIMENSIONS into the native column
    (rows written before pgvector was enabled, or imported). Returns the number of rows converted."""
    from app.db import USE_PGVECTOR

    if not USE_PGVECTOR:
        return 0
    dims = get_settings().pgvector_dimensions
    moved = 0
    last_id = ""
    while True:  # keyset pagination: rows that must stay in JSON (other widths) never block later ones
        rows = (
            await session.execute(
                select(Chunk)
                .where(Chunk.id > last_id)
                .where(Chunk.embedding.is_not(None))
                .where(Chunk.embedding_vec.is_(None))
                .order_by(Chunk.id)
                .limit(batch)
            )
        ).scalars().all()
        if not rows:
            return moved
        last_id = rows[-1].id
        for ch in rows:
            if isinstance(ch.embedding, list) and len(ch.embedding) == dims:
                ch.embedding_vec = ch.embedding
                ch.embedding = None
                moved += 1
        await session.flush()
