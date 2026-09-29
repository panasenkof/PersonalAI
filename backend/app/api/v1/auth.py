from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import LoginIn, RegisterIn, TokenOut
from app.db import get_session
from app.security.auth import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.services.users import bootstrap_user, get_user_by_email

router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut)
async def register(body: RegisterIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    email = body.email.lower()
    if await get_user_by_email(session, email):
        raise HTTPException(409, detail="email_taken")
    user = await bootstrap_user(session, email, hash_password(body.password))
    await session.commit()
    return TokenOut(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@router.post("/token", response_model=TokenOut)
async def login(body: LoginIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    email = body.email.lower()
    user = await get_user_by_email(session, email)
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, detail="invalid_credentials")
    return TokenOut(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=TokenOut)
async def refresh(body: RefreshIn) -> TokenOut:
    """Exchange a refresh token for a fresh access/refresh pair."""
    uid = decode_token(body.refresh_token, expected_type="refresh")
    if not uid:
        raise HTTPException(401, detail="invalid_refresh_token")
    return TokenOut(
        access_token=create_access_token(uid),
        refresh_token=create_refresh_token(uid),
    )
