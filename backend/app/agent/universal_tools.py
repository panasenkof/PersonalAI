from __future__ import annotations

import asyncio
import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.memory.contracts import NewEntity
from app.memory.privacy import cloud_allowed_collections, cloud_scope, filter_cloud_entities, filter_cloud_hits
from app.memory.repository import MemoryAccessError
from app.memory.sqlalchemy import SqlAlchemyMemoryRepository
from app.rag.search import hybrid_search


async def kb_search(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Hybrid retrieval: semantic embeddings + substring over entities/observations."""
    q = (args.get("query") or "").strip()
    if not q:
        return {"hits": []}
    scope = cloud_scope()
    if scope is not None:
        scope &= await cloud_allowed_collections(session, user_id)
        if not scope:
            return {"hits": []}
    # Cloud requests never send the query for remote embedding (lexical-only).
    hits = await hybrid_search(session, user_id, q, k=30 if scope is not None else 15)
    if scope is not None:
        hits = await filter_cloud_hits(session, user_id, hits, scope)
    return {"hits": hits[:15]}


async def kb_list_entities(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    domain = args.get("domain")
    limit = min(100, max(1, int(args.get("limit", 50))))
    offset = max(0, int(args.get("offset", 0)))
    scope = cloud_scope()
    if scope is not None:
        scope &= await cloud_allowed_collections(session, user_id)
        rows, next_offset = await filter_cloud_entities(
            session, user_id, scope, domain=domain, limit=limit, offset=offset,
        )
        return {
            "entities": [{"id": e.id, "domain": e.domain, "payload": e.payload} for e in rows],
            "next_offset": next_offset,
        }
    page = await SqlAlchemyMemoryRepository(session, user_id).entities(
        domain=domain, limit=limit, offset=offset,
    )
    return {
        "entities": [{"id": e.id, "domain": e.domain, "payload": e.payload} for e in page.items],
        "next_offset": page.next_offset,
    }


async def kb_create_entity(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    slug = args.get("collection_slug") or "garage"
    repository = SqlAlchemyMemoryRepository(session, user_id)
    col = await repository.collection_by_slug(slug)
    if col is None:
        return {"error": f"collection_not_found:{slug}"}
    try:
        entity = await repository.create_entity(NewEntity(
            collection_id=col.id, domain=args["domain"],
            schema_version=str(args.get("schema_version") or "1"),
            payload=args["payload"],
        ))
    except MemoryAccessError:
        return {"error": f"collection_not_found:{slug}"}
    from app.rag.indexing import index_entity

    await index_entity(session, user_id, entity)
    return {"entity_id": entity.id, "status": "created"}


async def kb_ingest_document(session: AsyncSession, user_id: str, args: dict[str, Any]) -> dict[str, Any]:
    """Store an uploaded PDF/text file as a searchable note: text is extracted, chunked and embedded."""
    from app.services.blobs import get_blob
    from app.services.documents import extract_document_text
    from app.storage.blob import read_bytes

    storage_key = args.get("storage_key")
    if not storage_key:
        return {"error": "no_storage_key"}
    blob = await get_blob(session, user_id, storage_key)
    if blob is None:
        return {"error": "unknown_storage_key"}
    text = await asyncio.to_thread(extract_document_text, await read_bytes(storage_key), args.get("mime") or blob.mime, blob.filename)
    if not text.strip():
        return {"error": "no_extractable_text", "message": "Scanned image or unsupported format."}
    slug = args.get("collection_slug") or "garage"
    repository = SqlAlchemyMemoryRepository(session, user_id)
    col = await repository.collection_by_slug(slug)
    if col is None:
        return {"error": f"collection_not_found:{slug}"}
    title = str(args.get("title") or blob.filename or "Документ")[:200]
    try:
        entity = await repository.create_entity(NewEntity(
            collection_id=col.id, domain="documents",
            payload={"type": "document", "title": title, "filename": blob.filename, "storage_key": storage_key,
                     "chars": len(text)},
        ))
    except MemoryAccessError:
        return {"error": f"collection_not_found:{slug}"}
    from app.rag.indexing import index_entity, index_text

    await index_entity(session, user_id, entity)
    chunks = await index_text(session, user_id, text, entity_id=entity.id)
    return {"entity_id": entity.id, "title": title, "chars": len(text), "chunks": chunks, "status": "ingested"}


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
                "properties": {
                    "domain": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    "offset": {"type": "integer", "minimum": 0},
                },
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
    {
        "type": "function",
        "function": {
            "name": "kb_ingest_document",
            "description": (
                "Save an attached PDF/text document into the knowledge base (extracts text, makes it "
                "searchable). Use for documents that are not lab reports."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "storage_key": {"type": "string"},
                    "mime": {"type": "string"},
                    "title": {"type": "string"},
                    "collection_slug": {"type": "string"},
                },
                "required": ["storage_key"],
                "additionalProperties": False,
            },
        },
    },
]


UNIVERSAL_TOOL_HANDLERS = {
    "kb_search": kb_search,
    "kb_list_entities": kb_list_entities,
    "kb_create_entity": kb_create_entity,
    "kb_ingest_document": kb_ingest_document,
}


def parse_tool_arguments(arguments: str | None) -> dict[str, Any]:
    if not arguments:
        return {}
    try:
        parsed = json.loads(arguments)
        return parsed if isinstance(parsed, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}
