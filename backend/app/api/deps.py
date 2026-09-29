from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User, UserRole
from app.services.users import authenticate_token


async def get_current_user(
    authorization: str | None = Header(None),
    session: AsyncSession = Depends(get_session),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    user = await authenticate_token(session, authorization.removeprefix("Bearer ").strip())
    if not user:
        raise HTTPException(status_code=401, detail="invalid_token")
    return user


async def get_current_user_flexible(
    authorization: str | None = Header(None),
    access_token: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Bearer header or `access_token` query param (for EventSource URLs)."""
    token = access_token
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing_bearer")
    user = await authenticate_token(session, token)
    if not user:
        raise HTTPException(status_code=401, detail="invalid_token")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != UserRole.admin.value:
        raise HTTPException(status_code=403, detail="admin_required")
    return user
