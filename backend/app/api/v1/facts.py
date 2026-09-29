from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_session
from app.models import User
from app.services.facts import FactError, fact_view, list_facts, resolve_fact

router = APIRouter(prefix="/v1/facts", tags=["facts"])


@router.get("")
async def get_facts(
    status: str | None = "pending_user_confirm",
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Facts extracted from photos/documents (default: those waiting for confirmation)."""
    return {"facts": [fact_view(f) for f in await list_facts(session, user.id, status or None)]}


async def _resolve(session: AsyncSession, user: User, fact_id: str, confirm: bool) -> dict:
    try:
        out = await resolve_fact(session, user.id, fact_id, confirm=confirm)
    except FactError as exc:
        code = 404 if exc.code == "fact_not_found" else 409
        raise HTTPException(code, detail=exc.code) from None
    await session.commit()
    return out


@router.post("/{fact_id}/confirm")
async def confirm_fact(
    fact_id: str, session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict:
    return await _resolve(session, user, fact_id, True)


@router.post("/{fact_id}/reject")
async def reject_fact(
    fact_id: str, session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict:
    return await _resolve(session, user, fact_id, False)
