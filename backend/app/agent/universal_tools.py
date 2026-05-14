from __future__ import annotations

import json
from typing import Any

from sqlalchemy import Select, cast, select, String
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Collection, Entity, Observation


async def kb_search(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    q = (args.get("query") or "").strip()
    if not q:
        return {"hits": []}
    like = f"%{q}%"
    stmt: Select[tuple[Entity]] = select(Entity).where(Entity.user_id == user_id)
    stmt = stmt.where(cast(Entity.payload, String).ilike(like))
    res = await session.execute(stmt)
    entities = list(res.scalars().all())
    hits = [{"kind": "entity", "id": e.id, "domain": e.domain, "payload": e.payload} for e in entities[:20]]
    stmt2 = select(Observation).where(Observation.user_id == user_id).where(cast(Observation.payload, String).ilike(like))
    res2 = await session.execute(stmt2)
    obs = list(res2.scalars().all())
    hits.extend([{"kind": "observation", "id": o.id, "entity_id": o.entity_id, "payload": o.payload} for o in obs[:20]])
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
    return {"entity_id": e.id, "status": "created"}


UNIVERSAL_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "kb_search",
            "description": "Search user's knowledge base (entities and observations) by substring.",
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
