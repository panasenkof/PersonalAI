from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User
from app.security.auth import decode_token


async def get_current_user(
    authorization: str | None = Header(None),
    session: AsyncSession = Depends(get_session),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    uid = decode_token(authorization.removeprefix("Bearer ").strip())
    if not uid:
        raise HTTPException(status_code=401, detail="invalid_token")
    user = await session.get(User, uid)
    if not user:
        raise HTTPException(status_code=401, detail="user_not_found")
    return user
