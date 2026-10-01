from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Text, cast, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.api.deps import get_current_user
from app.api.schemas import LoginIn, RegisterIn, TokenOut
from app.config import get_settings
from app.db import get_session
from app.models import User
from app.security import totp
from app.security.auth import (
    create_access_token,
    create_refresh_token,
    hash_password,
    verify_password,
)
from app.security.ratelimit import AsyncLimiter, build_limiter
from app.services.users import authenticate_token, bootstrap_user, get_user_by_email

router = APIRouter(prefix="/v1/auth", tags=["auth"])

_login_limiter: AsyncLimiter | None = None


def _limiter() -> AsyncLimiter:
    global _login_limiter
    if _login_limiter is None:
        s = get_settings()
        _login_limiter = build_limiter("login-fail", s.login_max_failures, s.login_lockout_seconds)
    return _login_limiter


def reset_login_limiter() -> None:
    global _login_limiter
    _login_limiter = None


_DUMMY_HASH = hash_password("timing-equalizer")


def _tokens(user: User) -> TokenOut:
    tv = int(user.token_version or 0)
    return TokenOut(
        access_token=create_access_token(user.id, tv),
        refresh_token=create_refresh_token(user.id, tv),
    )


@router.post("/register", response_model=TokenOut)
async def register(body: RegisterIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    email = body.email.lower()
    if await get_user_by_email(session, email):
        raise HTTPException(409, detail="email_taken")
    user = await bootstrap_user(session, email, hash_password(body.password))
    await session.commit()
    return _tokens(user)


async def _check_second_factor(session: AsyncSession, user: User, otp: str | None) -> bool:
    """TOTP first (each time-step usable once), then a one-time recovery code (which is consumed)."""
    if not otp:
        return False
    if user.totp_secret:
        step = totp.match_step(user.totp_secret, otp)
        if step is not None:
            # compare-and-set: a code that was already accepted (or a concurrent replay) loses
            res = await session.execute(
                update(User)
                .where(User.id == user.id)
                .where(or_(User.totp_last_step.is_(None), User.totp_last_step < step))
                .values(totp_last_step=step)
            )
            if res.rowcount == 1:  # type: ignore[attr-defined]
                user.totp_last_step = step
                return True
            return False
    raw_codes = await session.scalar(select(cast(User.recovery_codes, Text)).where(User.id == user.id))
    remaining = totp.consume_recovery_code(json.loads(raw_codes) if raw_codes else None, otp)
    if remaining is not None:
        res = await session.execute(
            update(User).where(User.id == user.id).where(cast(User.recovery_codes, Text) == raw_codes)
            .values(recovery_codes=remaining).execution_options(synchronize_session=False)
        )
        if res.rowcount != 1:  # type: ignore[attr-defined]
            return False
        set_committed_value(user, "recovery_codes", remaining)
        return True
    return False


@router.post("/token", response_model=TokenOut)
async def login(body: LoginIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    email = body.email.lower()
    s = get_settings()
    limiter = _limiter()
    if s.login_max_failures > 0 and await limiter.count(email) >= s.login_max_failures:
        raise HTTPException(429, detail="too_many_failed_attempts")
    user = await get_user_by_email(session, email)

    async def fail(detail: str) -> HTTPException:
        await limiter.allow(email)  # records a failure for this account
        return HTTPException(401, detail=detail)

    # always run one bcrypt verification so response time does not reveal whether the e-mail exists
    password_ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if not user or not password_ok or not user.is_active:
        raise await fail("invalid_credentials")
    if user.totp_enabled:
        if not body.otp:
            raise HTTPException(401, detail="otp_required")  # not a failure: the client just asks for the code
        if not await _check_second_factor(session, user, body.otp):
            raise await fail("invalid_otp")
        await session.commit()  # persists a consumed recovery code
    await limiter.reset(email)
    return _tokens(user)


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=TokenOut)
async def refresh(body: RefreshIn, session: AsyncSession = Depends(get_session)) -> TokenOut:
    """Exchange a refresh token for a fresh access/refresh pair."""
    user = await authenticate_token(session, body.refresh_token, expected_type="refresh")
    if not user:
        raise HTTPException(401, detail="invalid_refresh_token")
    return _tokens(user)


@router.get("/me")
async def me(user: User = Depends(get_current_user)) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "totp_enabled": bool(user.totp_enabled),
        "channels": {
            "telegram": bool(user.telegram_user_id),
            "slack": bool(user.slack_user_id),
            "whatsapp": bool(user.whatsapp_user_id),
            "discord": bool(user.discord_user_id),
        },
    }


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)
    otp: str | None = None


@router.post("/password", response_model=TokenOut)
async def change_password(
    body: PasswordChangeIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> TokenOut:
    """Changing the password revokes every previously issued token."""
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(401, detail="invalid_credentials")
    if user.totp_enabled and not await _check_second_factor(session, user, body.otp):
        raise HTTPException(401, detail="invalid_otp")
    user.password_hash = hash_password(body.new_password)
    user.token_version = int(user.token_version or 0) + 1
    await session.commit()
    return _tokens(user)


@router.post("/logout-all", status_code=204)
async def logout_all(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> None:
    """Revoke all access/refresh tokens of this account (every device)."""
    user.token_version = int(user.token_version or 0) + 1
    await session.commit()


# --- two-factor authentication (TOTP) ---------------------------------------------------------


class OtpIn(BaseModel):
    code: str


class Disable2FAIn(BaseModel):
    password: str
    code: str


@router.post("/2fa/setup")
async def twofa_setup(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict:
    """Step 1: generate a secret (shown once as text + otpauth:// URI for QR apps)."""
    if user.totp_enabled:
        raise HTTPException(409, detail="2fa_already_enabled")
    user.totp_secret = totp.generate_secret()
    await session.commit()
    return {
        "secret": user.totp_secret,
        "otpauth_uri": totp.provisioning_uri(user.email, user.totp_secret, get_settings().app_name),
    }


@router.post("/2fa/enable")
async def twofa_enable(
    body: OtpIn, session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict:
    """Step 2: confirm with a valid code; returns one-time recovery codes (store them safely)."""
    if user.totp_enabled:
        raise HTTPException(409, detail="2fa_already_enabled")
    step = totp.match_step(user.totp_secret, body.code) if user.totp_secret else None
    if step is None:
        raise HTTPException(401, detail="invalid_otp")
    user.totp_last_step = step  # the code that proved possession cannot be replayed for a login
    plain, hashes = totp.generate_recovery_codes()
    user.totp_enabled = True
    user.recovery_codes = hashes
    await session.commit()
    return {"enabled": True, "recovery_codes": plain}


@router.post("/2fa/disable")
async def twofa_disable(
    body: Disable2FAIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict:
    if not user.totp_enabled:
        raise HTTPException(409, detail="2fa_not_enabled")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(401, detail="invalid_credentials")
    if not await _check_second_factor(session, user, body.code):
        raise HTTPException(401, detail="invalid_otp")
    user.totp_enabled = False
    user.totp_secret = None
    user.recovery_codes = None
    await session.commit()
    return {"enabled": False}
