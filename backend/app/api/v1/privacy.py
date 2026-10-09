"""Authenticated owner privacy controls for memory egress."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_session
from app.models import Collection, LLMSettings, User

router = APIRouter(prefix="/v1/privacy", tags=["privacy"])


class CollectionPrivacyIn(BaseModel):
    sensitivity: Literal["unclassified", "standard", "sensitive", "secret"]
    allow_cloud_llm: bool = False
    allow_remote_embeddings: bool = False


class HistoryPrivacyIn(BaseModel):
    allow_cloud_history: bool = False


@router.get("/collections")
async def collections_privacy(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> list[dict]:
    rows = (await session.scalars(
        select(Collection).where(Collection.user_id == user.id).order_by(Collection.slug)
    )).all()
    return [
        {"slug": c.slug, "sensitivity": c.sensitivity,
         "allow_cloud_llm": c.allow_cloud_llm, "allow_remote_embeddings": c.allow_remote_embeddings}
        for c in rows
    ]


@router.put("/collections/{slug}")
async def update_collection_privacy(
    slug: str, body: CollectionPrivacyIn,
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> dict:
    col = await session.scalar(
        select(Collection).where(Collection.user_id == user.id, Collection.slug == slug)
    )
    if col is None:
        raise HTTPException(status_code=404, detail="collection_not_found")
    if body.sensitivity in {"unclassified", "secret"} and (
        body.allow_cloud_llm or body.allow_remote_embeddings
    ):
        raise HTTPException(status_code=422, detail="classify_collection_before_cloud_access")
    col.sensitivity = body.sensitivity
    col.allow_cloud_llm = body.allow_cloud_llm
    col.allow_remote_embeddings = body.allow_remote_embeddings
    await session.commit()
    return {
        "slug": col.slug, "sensitivity": col.sensitivity,
        "allow_cloud_llm": col.allow_cloud_llm,
        "allow_remote_embeddings": col.allow_remote_embeddings,
    }


@router.get("/conversation")
async def get_history_privacy(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> dict:
    row = await session.get(LLMSettings, user.id)
    return {"allow_cloud_history": bool(row and row.cloud_history_access)}


@router.put("/conversation")
async def update_history_privacy(
    body: HistoryPrivacyIn,
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> dict:
    from app.services.users import get_or_create_llm_settings

    row = await get_or_create_llm_settings(session, user.id)
    row.cloud_history_access = body.allow_cloud_history
    await session.commit()
    return {"allow_cloud_history": row.cloud_history_access}
