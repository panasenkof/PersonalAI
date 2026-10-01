from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth import _check_second_factor
from app.config import get_settings
from app.db import get_session
from app.models import EmailAction, MailOutbox, User, utcnow
from app.security.auth import hash_password
from app.security.ratelimit import build_limiter
from app.services.mail import mail_configured
from app.services.users import get_user_by_email

router = APIRouter(prefix='/v1/auth', tags=['account access'])
_GENERIC = {'message': 'Если аккаунт существует, письмо с инструкцией будет отправлено. Проверьте также папку «Спам».'}
_limiters: dict[tuple[str, int], object] = {}


class EmailRequest(BaseModel):
    email: EmailStr


class TokenInput(BaseModel):
    token: str = Field(min_length=20, max_length=128)


class ResetInput(TokenInput):
    new_password: str = Field(min_length=8, max_length=128)
    otp: str | None = None


async def queue_action(session: AsyncSession, user: User, purpose: str) -> None:
    token = secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(minutes=30 if purpose == 'reset' else 24 * 60)
    session.add(EmailAction(id=hashlib.sha256(token.encode()).hexdigest(), user_id=user.id, purpose=purpose, token_version=user.token_version, expires_at=expires))
    title = 'Сброс пароля PIA' if purpose == 'reset' else 'Подтверждение email PIA'
    url = f'{get_settings().public_base_url.rstrip("/")}/app/access.html#{purpose}={token}'
    # Fragment is not sent in HTTP requests or Referer headers.
    session.add(MailOutbox(user_id=user.id, recipient=user.email, subject=title, body=f'{title}\n\nОткройте ссылку: {url}\nКод: {token}\n\nСсылка одноразовая. Если вы не запрашивали письмо, проигнорируйте его.', expires_at=expires))


async def request_action(body: EmailRequest, purpose: str, session: AsyncSession) -> dict:
    started = time.monotonic()
    if not mail_configured():
        raise HTTPException(503, detail='email_service_unavailable')
    s = get_settings()
    key = (s.redis_url, s.email_action_requests_per_hour)
    if key not in _limiters:
        _limiters[key] = build_limiter('email-actions', s.email_action_requests_per_hour, 3600)
    email = str(body.email).lower()
    allowed = await _limiters[key].allow(hashlib.sha256(email.encode()).hexdigest())  # type: ignore[attr-defined]
    if allowed:
        user = await get_user_by_email(session, email)
        if user and user.is_active and (purpose != 'verify' or not user.email_verified):
            await queue_action(session, user, purpose)
            await session.commit()
    await asyncio.sleep(max(0, .15 - (time.monotonic() - started)))
    return _GENERIC


@router.post('/password/request', status_code=202)
async def request_reset(body: EmailRequest, session: AsyncSession = Depends(get_session)) -> dict:
    return await request_action(body, 'reset', session)


@router.post('/email/request', status_code=202)
async def request_verify(body: EmailRequest, session: AsyncSession = Depends(get_session)) -> dict:
    return await request_action(body, 'verify', session)


async def consume(session: AsyncSession, token: str, purpose: str) -> tuple[EmailAction, User]:
    digest = hashlib.sha256(token.encode()).hexdigest()
    row = await session.scalar(select(EmailAction).where(EmailAction.id == digest, EmailAction.purpose == purpose, EmailAction.used_at.is_(None), EmailAction.expires_at > utcnow()))
    user = await session.get(User, row.user_id) if row else None
    if not row or not user or not user.is_active or row.token_version != user.token_version:
        raise HTTPException(400, detail='invalid_or_expired_code')
    claimed = await session.execute(update(EmailAction).where(EmailAction.id == digest, EmailAction.used_at.is_(None), EmailAction.expires_at > utcnow()).values(used_at=utcnow()).execution_options(synchronize_session=False))
    if claimed.rowcount != 1:  # type: ignore[attr-defined]
        raise HTTPException(400, detail='invalid_or_expired_code')
    return row, user


@router.post('/password/reset')
async def reset_password(body: ResetInput, session: AsyncSession = Depends(get_session)) -> dict:
    row, user = await consume(session, body.token, 'reset')
    if user.totp_enabled and not await _check_second_factor(session, user, body.otp):
        raise HTTPException(400, detail='invalid_otp')
    result = await session.execute(update(User).where(User.id == user.id, User.token_version == row.token_version).values(password_hash=hash_password(body.new_password), token_version=User.token_version + 1))
    if result.rowcount != 1:  # type: ignore[attr-defined]
        raise HTTPException(400, detail='invalid_or_expired_code')
    await session.commit()
    return {'message': 'Пароль изменён. Войдите с новым паролем. Все прежние сессии завершены.'}


@router.post('/email/verify')
async def verify_email(body: TokenInput, session: AsyncSession = Depends(get_session)) -> dict:
    row, user = await consume(session, body.token, 'verify')
    result = await session.execute(update(User).where(User.id == user.id, User.token_version == row.token_version).values(email_verified=True))
    if result.rowcount != 1:  # type: ignore[attr-defined]
        raise HTTPException(400, detail='invalid_or_expired_code')
    await session.commit()
    return {'message': 'Email подтверждён. Теперь можно войти.'}
