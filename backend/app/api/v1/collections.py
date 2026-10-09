from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_session
from app.memory.sqlalchemy import SqlAlchemyMemoryRepository
from app.models import User

router = APIRouter(prefix="/v1/collections", tags=["collections"])


@router.get("")
async def list_collections(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    rows = await SqlAlchemyMemoryRepository(session, user.id).list_collections()
    return [{"id": c.id, "name": c.name, "slug": c.slug} for c in rows]


@router.get("/{slug}/entities")
async def list_entities_by_slug(
    slug: str,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    repository = SqlAlchemyMemoryRepository(session, user.id)
    col = await repository.collection_by_slug(slug)
    if col is None:
        return []
    page = await repository.entities(collection_id=col.id, limit=limit, offset=offset)
    return [{"id": e.id, "domain": e.domain, "payload": e.payload} for e in page.items]
