"""Personal-memory egress decisions (fail closed unless the owner opted in).

Local means a loopback OpenAI-compatible endpoint, not a self-described 'local'
provider that can actually resolve to the public internet. This only protects
application-managed memory, not text explicitly typed in a cloud chat.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm.providers import LLMProvider, LocalLLMProvider
from app.models import Collection, Entity, Observation

_CLOUD_MEMORY_SCOPE: ContextVar[frozenset[str] | None] = ContextVar("cloud_memory_scope", default=None)
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_CLASSIFIED = frozenset({"standard", "sensitive"})


def is_trusted_local_provider(provider: LLMProvider) -> bool:
    if not isinstance(provider, LocalLLMProvider):
        return False
    try:
        url = urlsplit(provider.base_url)
        return url.hostname in _LOCAL_HOSTS and url.scheme in {"http", "https"}
    except (AttributeError, ValueError):
        return False


def cloud_scope() -> frozenset[str] | None:
    """None: trusted local or direct authenticated calls. Set: cloud tool context."""
    return _CLOUD_MEMORY_SCOPE.get()


@contextmanager
def use_cloud_scope(allowed_collection_ids: frozenset[str] | None):
    token = _CLOUD_MEMORY_SCOPE.set(allowed_collection_ids)
    try:
        yield
    finally:
        _CLOUD_MEMORY_SCOPE.reset(token)


async def cloud_allowed_collections(
    session: AsyncSession, user_id: str, *, embeddings: bool = False,
) -> frozenset[str]:
    grant = Collection.allow_remote_embeddings if embeddings else Collection.allow_cloud_llm
    rows = await session.scalars(
        select(Collection.id).where(
            Collection.user_id == user_id,
            Collection.sensitivity.in_(_CLASSIFIED),
            grant.is_(True),
        )
    )
    return frozenset(rows.all())


async def remote_embedding_allowed(
    session: AsyncSession, user_id: str, collection_id: str | None,
) -> bool:
    if not collection_id:
        return False
    return collection_id in await cloud_allowed_collections(session, user_id, embeddings=True)


def visible_memory_hit(
    hit: dict, allowed: frozenset[str],
    entities: dict[str, Entity], observations: dict[str, Observation],
) -> bool:
    entity = entities.get(hit.get("entity_id") or "")
    if entity is None or entity.collection_id not in allowed:
        return False
    if entity.sensitivity not in {"inherit", "standard"}:
        return False
    if hit.get("observation_id"):
        observation = observations.get(hit["observation_id"])
        if observation is None or observation.entity_id != entity.id:
            return False
        if observation.sensitivity not in {"inherit", "standard"}:
            return False
    return True


async def filter_cloud_hits(
    session: AsyncSession, user_id: str, hits: list[dict], allowed: frozenset[str],
) -> list[dict]:
    if not allowed or not hits:
        return []
    ids = {h["entity_id"] for h in hits if h.get("entity_id")}
    observation_ids = {h["observation_id"] for h in hits if h.get("observation_id")}
    entities = {
        e.id: e for e in (await session.scalars(
            select(Entity).where(Entity.user_id == user_id, Entity.id.in_(ids))
        )).all()
    } if ids else {}
    observations = {
        o.id: o for o in (await session.scalars(
            select(Observation).where(Observation.user_id == user_id, Observation.id.in_(observation_ids))
        )).all()
    } if observation_ids else {}
    return [h for h in hits if visible_memory_hit(h, allowed, entities, observations)]


async def filter_cloud_entities(
    session: AsyncSession, user_id: str, allowed: frozenset[str],
    *, domain: str | None, limit: int, offset: int,
) -> tuple[list[Entity], int | None]:
    if not allowed:
        return [], None
    stmt = select(Entity).where(
        Entity.user_id == user_id,
        Entity.collection_id.in_(allowed),
        Entity.sensitivity.in_(("inherit", "standard")),
    )
    if domain:
        stmt = stmt.where(Entity.domain == domain)
    rows = (await session.scalars(
        stmt.order_by(Entity.created_at, Entity.id).offset(offset).limit(limit + 1)
    )).all()
    return list(rows[:limit]), offset + limit if len(rows) > limit else None
