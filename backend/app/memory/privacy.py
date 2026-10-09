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
_EXTERNAL_SCOPE_KIND: ContextVar[str] = ContextVar("external_memory_scope_kind", default="cloud")
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
    """None: trusted local call. Set: external LLM or MCP scoped tool."""
    return _CLOUD_MEMORY_SCOPE.get()


async def scoped_allowed_collections(session: AsyncSession, user_id: str) -> frozenset[str]:
    """Revalidate grant for this integration, including mid-session revocation."""
    return (await mcp_allowed_collections(session, user_id)
            if _EXTERNAL_SCOPE_KIND.get() == "mcp"
            else await cloud_allowed_collections(session, user_id))


@contextmanager
def use_cloud_scope(allowed_collection_ids: frozenset[str] | None, *, channel: str = "cloud"):
    if channel not in {"cloud", "mcp"}:
        raise ValueError("invalid_memory_egress_channel")
    token = _CLOUD_MEMORY_SCOPE.set(allowed_collection_ids)
    channel_token = _EXTERNAL_SCOPE_KIND.set(channel)
    try:
        yield
    finally:
        _EXTERNAL_SCOPE_KIND.reset(channel_token)
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


async def mcp_allowed_collections(session: AsyncSession, user_id: str) -> frozenset[str]:
    rows = await session.scalars(
        select(Collection.id).where(
            Collection.user_id == user_id, Collection.sensitivity.in_(_CLASSIFIED),
            Collection.allow_mcp_access.is_(True),
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


# Explicit allowlist only: unreviewed domain tools may query many categories or
# reach further third-party APIs and are never available to a remote model.
_CLOUD_COLLECTION_TOOLS = frozenset({
    "kb_create_entity", "kb_ingest_document", "auto_add_vehicle",
})
_CLOUD_ENTITY_TOOLS = frozenset({"auto_add_service_event"})
_CLOUD_HEALTH_TOOLS = frozenset({"labs_record_report", "labs_get_trends"})


async def cloud_tool_allowed(
    session: AsyncSession, user_id: str, name: str, args: dict,
    allowed: frozenset[str],
) -> bool:
    """Re-check the exact target at dispatch time, not only at tool schema exposure."""
    allowed &= await scoped_allowed_collections(session, user_id)
    if not allowed:
        return False
    if name in {"kb_search", "kb_list_entities"}:
        return True
    if name in _CLOUD_COLLECTION_TOOLS:
        slug = str(args.get("collection_slug") or "garage")
        row = await session.scalar(
            select(Collection.id).where(
                Collection.user_id == user_id, Collection.slug == slug,
                Collection.id.in_(allowed),
            )
        )
        return row is not None
    if name in _CLOUD_ENTITY_TOOLS:
        entity_id = args.get("vehicle_entity_id")
        if not isinstance(entity_id, str):
            return False
        row = await session.scalar(
            select(Entity.id).where(
                Entity.user_id == user_id, Entity.id == entity_id,
                Entity.collection_id.in_(allowed),
                Entity.sensitivity.in_(("inherit", "standard")),
            )
        )
        return row is not None
    if name in _CLOUD_HEALTH_TOOLS:
        row = await session.scalar(
            select(Collection.id).where(
                Collection.user_id == user_id, Collection.slug == "health",
                Collection.id.in_(allowed),
            )
        )
        return row is not None
    return False



def is_loopback_url(value: str) -> bool:
    """Only this machine, not RFC1918 LAN or arbitrary private DNS names."""
    try:
        parsed = urlsplit(value)
        return parsed.scheme in {"http", "https"} and parsed.hostname in _LOCAL_HOSTS
    except (ValueError, TypeError):
        return False


async def remote_extraction_allowed(
    session: AsyncSession, user_id: str, collection_slug: str,
    *, entity: Entity | None = None,
) -> bool:
    """An explicit collection opt-in is required for outbound OCR/vision/parsing."""
    if entity is not None and (
        entity.user_id != user_id or entity.sensitivity not in {"inherit", "standard"}
    ):
        return False
    stmt = select(Collection.id).where(
        Collection.user_id == user_id, Collection.slug == collection_slug,
        Collection.sensitivity.in_(_CLASSIFIED),
        Collection.allow_remote_extraction.is_(True),
    )
    if entity is not None:
        stmt = stmt.where(Collection.id == entity.collection_id)
    return await session.scalar(stmt) is not None
