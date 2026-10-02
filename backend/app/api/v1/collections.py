from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_session
from app.models import Collection, Entity, User

router = APIRouter(prefix="/v1/collections", tags=["collections"])


@router.get("")
async def list_collections(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    res = await session.execute(select(Collection).where(Collection.user_id == user.id))
    rows = list(res.scalars().all())
    return [{"id": c.id, "name": c.name, "slug": c.slug} for c in rows]


@router.get("/{slug}/entities")
async def list_entities_by_slug(
    slug: str,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    res = await session.execute(select(Collection).where(Collection.user_id == user.id).where(Collection.slug == slug))
    col = res.scalar_one_or_none()
    if not col:
        return []
    res2 = await session.execute(select(Entity).where(Entity.collection_id == col.id, Entity.user_id == user.id).order_by(Entity.created_at, Entity.id).offset(offset).limit(limit))
    ents = list(res2.scalars().all())
    return [{"id": e.id, "domain": e.domain, "payload": e.payload} for e in ents]
