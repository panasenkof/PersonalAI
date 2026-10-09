"""Authenticated owner privacy controls for memory egress."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_session
from app.models import Chunk, Collection, Entity, LLMSettings, User

router = APIRouter(prefix="/v1/privacy", tags=["privacy"])


class CollectionPrivacyIn(BaseModel):
    sensitivity: Literal["unclassified", "standard", "sensitive", "secret"]
    allow_cloud_llm: bool = False
    allow_remote_embeddings: bool = False
    allow_remote_extraction: bool = False
    allow_messenger_reminders: bool = False


class HistoryPrivacyIn(BaseModel):
    allow_cloud_history: bool = False


class IntegrationPrivacyIn(BaseModel):
    allow_remote_stt: bool = False
    allow_mcp_access: bool = False


@router.get("/collections")
async def collections_privacy(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> list[dict]:
    rows = (await session.scalars(
        select(Collection).where(Collection.user_id == user.id).order_by(Collection.slug)
    )).all()
    return [
        {"slug": c.slug, "sensitivity": c.sensitivity,
         "allow_cloud_llm": c.allow_cloud_llm, "allow_remote_embeddings": c.allow_remote_embeddings,
         "allow_remote_extraction": c.allow_remote_extraction,
         "allow_messenger_reminders": c.allow_messenger_reminders}
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
        body.allow_cloud_llm or body.allow_remote_embeddings or body.allow_remote_extraction
        or body.allow_messenger_reminders
    ):
        raise HTTPException(status_code=422, detail="classify_collection_before_cloud_access")
    # Revoking vector consent also strips stored vectors for this collection,
    # including previous local vectors. Lexical chunks remain searchable.
    if col.allow_remote_embeddings and not body.allow_remote_embeddings:
        await session.execute(
            update(Chunk).where(
                Chunk.user_id == user.id,
                Chunk.entity_id.in_(
                    select(Entity.id).where(
                        Entity.user_id == user.id, Entity.collection_id == col.id,
                    )
                ),
            ).values(embedding=None, embedding_vec=None, embedding_space=None)
        )
    col.sensitivity = body.sensitivity
    col.allow_cloud_llm = body.allow_cloud_llm
    col.allow_remote_embeddings = body.allow_remote_embeddings
    col.allow_remote_extraction = body.allow_remote_extraction
    col.allow_messenger_reminders = body.allow_messenger_reminders
    await session.commit()
    return {
        "slug": col.slug, "sensitivity": col.sensitivity,
        "allow_cloud_llm": col.allow_cloud_llm,
        "allow_remote_embeddings": col.allow_remote_embeddings,
        "allow_remote_extraction": col.allow_remote_extraction,
        "allow_messenger_reminders": col.allow_messenger_reminders,
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



@router.get("/integrations")
async def get_integration_privacy(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> dict:
    row = await session.get(LLMSettings, user.id)
    return {
        "allow_remote_stt": bool(row and row.allow_remote_stt),
        "allow_mcp_access": bool(row and row.allow_mcp_access),
    }


@router.put("/integrations")
async def update_integration_privacy(
    body: IntegrationPrivacyIn,
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user),
) -> dict:
    from app.services.users import get_or_create_llm_settings

    row = await get_or_create_llm_settings(session, user.id)
    row.allow_remote_stt = body.allow_remote_stt
    row.allow_mcp_access = body.allow_mcp_access
    await session.commit()
    return {"allow_remote_stt": row.allow_remote_stt, "allow_mcp_access": row.allow_mcp_access}
