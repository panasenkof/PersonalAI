from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Collection, LLMSettings, User, UserRole


async def bootstrap_user(session: AsyncSession, email: str, password_hash: str) -> User:
    role = UserRole.admin.value if email.lower() in get_settings().admin_email_set else UserRole.user.value
    user = User(email=email, password_hash=password_hash, role=role)
    session.add(user)
    await session.flush()
    for name, slug in (("Garage", "garage"), ("Health", "health")):
        session.add(Collection(user_id=user.id, name=name, slug=slug))
    session.add(
        LLMSettings(
            user_id=user.id,
            provider_kind="cloud",
            base_url="https://api.openai.com/v1",
            default_model="gpt-4o-mini",
            supports_vision=True,
        )
    )
    await session.flush()
    return user


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    res = await session.execute(select(User).where(User.email == email))
    return res.scalar_one_or_none()


async def get_or_create_llm_settings(session: AsyncSession, user_id: str) -> LLMSettings:
    row = await session.get(LLMSettings, user_id)
    if row is not None:
        return row
    row = LLMSettings(
        user_id=user_id,
        provider_kind="cloud",
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
        supports_vision=True,
    )
    session.add(row)
    await session.flush()
    return row


async def authenticate_token(session: AsyncSession, token: str, expected_type: str = "access") -> User | None:
    """Resolve a JWT to an active user whose token version still matches (revocation support)."""
    from app.security.auth import decode_claims

    claims = decode_claims(token, expected_type)
    if not claims or not claims.get("sub"):
        return None
    user = await session.get(User, str(claims["sub"]))
    if user is None or not user.is_active:
        return None
    if int(claims.get("tv", 0)) != int(user.token_version or 0):
        return None
    return user
