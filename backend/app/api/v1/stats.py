from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_session
from app.models import ChatTurn, Conversation, Entity, IngestionJob, Observation, User

router = APIRouter(prefix="/v1", tags=["stats"])


@router.get("/stats")
async def user_stats(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Per-user usage overview: jobs, tokens, KB size (cost visibility)."""
    jobs = (
        await session.execute(
            select(IngestionJob.status, func.count())
            .where(IngestionJob.user_id == user.id)
            .group_by(IngestionJob.status)
        )
    ).all()
    job_counts = {status: count for status, count in jobs}

    prompt_tokens = 0
    completion_tokens = 0
    res = await session.stream(
        select(IngestionJob.result).where(IngestionJob.user_id == user.id).execution_options(yield_per=100)
    )
    async for (result,) in res:
        usage = (result or {}).get("usage") or (result or {}).get("raw_last", {}).get("usage") or {}
        prompt_tokens += int(usage.get("prompt_tokens") or 0)
        completion_tokens += int(usage.get("completion_tokens") or 0)

    conv_count = (
        await session.execute(
            select(func.count()).select_from(Conversation).where(Conversation.user_id == user.id)
        )
    ).scalar_one()
    turn_count = (
        await session.execute(
            select(func.count()).select_from(ChatTurn).where(ChatTurn.user_id == user.id)
        )
    ).scalar_one()
    entity_count = (
        await session.execute(
            select(func.count()).select_from(Entity).where(Entity.user_id == user.id)
        )
    ).scalar_one()
    obs_count = (
        await session.execute(
            select(func.count()).select_from(Observation).where(Observation.user_id == user.id)
        )
    ).scalar_one()

    return {
        "jobs": job_counts,
        "usage_tokens": {
            "prompt": prompt_tokens,
            "completion": completion_tokens,
            "total": prompt_tokens + completion_tokens,
        },
        "conversations": conv_count,
        "chat_turns": turn_count,
        "entities": entity_count,
        "observations": obs_count,
    }
