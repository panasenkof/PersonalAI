from __future__ import annotations

import logging

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


async def _index_texts(
    session: AsyncSession,
    user_id: str,
    texts: list[str],
    *,
    entity_id: str | None = None,
) -> int:
    chunks = [c for t in texts for c in split_text(t)]
    if not chunks:
        return 0
    embeddings = await _embed_texts(session, user_id, chunks)
    for i, text in enumerate(chunks):
        emb = embeddings[i] if embeddings is not None and i < len(embeddings) else None
        session.add(
            Chunk(
                user_id=user_id,
                entity_id=entity_id,
                text=text,
                embedding=emb,
                created_at=utcnow(),
            )
        )
    await session.flush()
    return len(chunks)


async def index_entity(session: AsyncSession, user_id: str, entity: Entity) -> int:
    text = flatten_payload(entity.payload or {})
    return await _index_texts(session, user_id, [text], entity_id=entity.id)


async def index_observation(session: AsyncSession, user_id: str, observation: Observation) -> int:
    text = flatten_payload(observation.payload or {})
    return await _index_texts(session, user_id, [text], entity_id=observation.entity_id)
