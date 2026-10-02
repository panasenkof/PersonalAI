from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.db import get_session
from app.models import ChannelDelivery, Chunk, IngestionJob, User

router = APIRouter(prefix="/v1/admin", tags=["admin"])


class UserPatch(BaseModel):
    role: Literal["user", "admin"] | None = None
    is_active: bool | None = None


def _view(u: User) -> dict:
    return {
        "id": u.id,
        "email": u.email,
        "role": u.role,
        "is_active": bool(u.is_active),
        "totp_enabled": bool(u.totp_enabled),
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


@router.get("/users")
async def list_users(
    session: AsyncSession = Depends(get_session), _: User = Depends(require_admin)
) -> dict:
    rows = (await session.execute(select(User).order_by(User.created_at.asc()).limit(1000))).scalars().all()
    return {"users": [_view(u) for u in rows]}


@router.patch("/users/{user_id}")
async def patch_user(
    user_id: str,
    body: UserPatch,
    session: AsyncSession = Depends(get_session),
    admin: User = Depends(require_admin),
) -> dict:
    target = await session.get(User, user_id)
    if target is None:
        raise HTTPException(404, detail="user_not_found")
    if target.id == admin.id and (body.role == "user" or body.is_active is False):
        raise HTTPException(409, detail="cannot_demote_or_disable_self")
    if body.role is not None:
        target.role = body.role
    if body.is_active is not None:
        target.is_active = body.is_active
        if not body.is_active:
            target.token_version = int(target.token_version or 0) + 1  # kick out active sessions
    await session.commit()
    return _view(target)


@router.get("/stats")
async def global_stats(
    session: AsyncSession = Depends(get_session), _: User = Depends(require_admin)
) -> dict:
    jobs = (await session.execute(select(IngestionJob.status, func.count()).group_by(IngestionJob.status))).all()
    users = (await session.execute(select(func.count()).select_from(User))).scalar_one()
    chunks = (await session.execute(select(func.count()).select_from(Chunk))).scalar_one()
    from app.queue.runner import get_runner

    deliveries = await session.scalar(select(func.count()).select_from(ChannelDelivery).where(ChannelDelivery.sent_at.is_(None)))
    return {
        "users": users,
        "chunks": chunks,
        "jobs": {status: n for status, n in jobs},
        "queue": await get_runner().stats(),
        "pending_channel_deliveries": deliveries,
    }
