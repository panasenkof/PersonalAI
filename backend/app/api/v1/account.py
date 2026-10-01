from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.v1.auth import _check_second_factor, _limiter
from app.db import get_session
from app.models import User
from app.security.auth import verify_password
from app.services.account import cleanup_deleted_blobs, delete_account, export_account

router = APIRouter(prefix='/v1/account', tags=['account data'])


class Reauth(BaseModel):
    password: str = Field(max_length=128)
    otp: str | None = None


class DeleteInput(Reauth):
    confirmation: str


async def reauthenticate(body: Reauth, user: User, session: AsyncSession) -> None:
    limiter = _limiter()
    key = 'account:' + user.id
    if await limiter.count(key) >= 5:
        raise HTTPException(429, detail='too_many_failed_attempts')
    if not verify_password(body.password, user.password_hash):
        await limiter.allow(key)
        raise HTTPException(400, detail='invalid_credentials')
    if user.totp_enabled and not await _check_second_factor(session, user, body.otp):
        await limiter.allow(key)
        raise HTTPException(400, detail='invalid_otp')
    await limiter.reset(key)


@router.post('/export')
async def export(body: Reauth, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)) -> Response:
    await reauthenticate(body, user, session)
    payload = await export_account(session, user)
    await session.commit()  # consumes one-time second factor
    return Response(payload, media_type='application/zip', headers={'Content-Disposition': 'attachment; filename="pia-account.zip"', 'Cache-Control': 'no-store'})


@router.post('/delete')
async def remove(body: DeleteInput, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)) -> dict:
    if body.confirmation != user.email:
        raise HTTPException(400, detail='type_email_to_confirm_deletion')
    await reauthenticate(body, user, session)
    await delete_account(session, user)
    # Failed physical cleanup remains durable and is retried by maintenance.
    await cleanup_deleted_blobs()
    return {'deleted': True, 'message': 'Аккаунт и данные удалены. Файлы при временной ошибке хранилища удалятся фоновой обработкой; резервные копии истекают по политике сервиса.'}
