from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Collection, Entity
from app.rag.search import hybrid_search


async def kb_search(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Hybrid retrieval: semantic embeddings + substring over entities/observations."""
    q = (args.get("query") or "").strip()
    if not q:
        return {"hits": []}
    hits = await hybrid_search(session, user_id, q, k=15)
    return {"hits": hits[:30]}


async def kb_list_entities(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    domain = args.get("domain")
    stmt = select(Entity).where(Entity.user_id == user_id)
    if domain:
        stmt = stmt.where(Entity.domain == domain)
    res = await session.execute(stmt)
    rows = list(res.scalars().all())
    return {"entities": [{"id": e.id, "domain": e.domain, "payload": e.payload} for e in rows[:50]]}


async def kb_create_entity(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    slug = args.get("collection_slug") or "garage"
    res = await session.execute(
        select(Collection).where(Collection.user_id == user_id).where(Collection.slug == slug)
    )
    col = res.scalar_one_or_none()
    if col is None:
        return {"error": f"collection_not_found:{slug}"}
    e = Entity(
        user_id=user_id,
        collection_id=col.id,
        domain=args["domain"],
        schema_version=str(args.get("schema_version") or "1"),
        payload=args["payload"],
    )
    session.add(e)
    await session.flush()
    from app.rag.indexing import index_entity

    await index_entity(session, user_id, e)
    return {"entity_id": e.id, "status": "created"}


UNIVERSAL_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "kb_search",
            "description": "Search the user's knowledge base (entities, observations, text chunks) — semantic + substring.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kb_list_entities",
            "description": "List entities for the user, optionally filtered by domain id.",
            "parameters": {
                "type": "object",
                "properties": {"domain": {"type": "string"}},
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kb_create_entity",
            "description": "Create a typed entity in a collection (slug like garage).",
            "parameters": {
                "type": "object",
                "properties": {
                    "collection_slug": {"type": "string"},
                    "domain": {"type": "string"},
                    "schema_version": {"type": "string"},
                    "payload": {"type": "object"},
                },
                "required": ["domain", "payload"],
                "additionalProperties": False,
            },
        },
    },
]


UNIVERSAL_TOOL_HANDLERS = {
    "kb_search": kb_search,
    "kb_list_entities": kb_list_entities,
    "kb_create_entity": kb_create_entity,
}


def parse_tool_arguments(arguments: str | None) -> dict[str, Any]:
    if not arguments:
        return {}
    try:
        return json.loads(arguments)
    except json.JSONDecodeError:
        return {}
