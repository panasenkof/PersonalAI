from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Collection, LLMSettings, User, UserRole


async def bootstrap_user(session: AsyncSession, email: str, password_hash: str) -> User:
    from app.config import get_settings

    settings = get_settings()
    role = UserRole.user.value  # public registration never grants administrative privileges
    user = User(email=email, password_hash=password_hash, role=role)
    session.add(user)
    await session.flush()
    # New accounts get explicit labels; migrated legacy collections stay "unclassified".
    for name, slug, sensitivity in (("Garage", "garage", "standard"), ("Health", "health", "sensitive")):
        session.add(Collection(user_id=user.id, name=name, slug=slug, sensitivity=sensitivity))
    session.add(
        LLMSettings(
            user_id=user.id,
            provider_kind="cloud",
            base_url=settings.default_llm_base_url,
            default_model=settings.default_llm_model,
            embedding_model=settings.default_embedding_model if settings.default_llm_api_key else None,
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
    from app.config import get_settings
    settings = get_settings()
    row = LLMSettings(
        user_id=user_id,
        provider_kind="cloud",
        base_url=settings.default_llm_base_url,
        default_model=settings.default_llm_model,
        embedding_model=settings.default_embedding_model if settings.default_llm_api_key else None,
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
    from app.config import get_settings

    if user is None or not user.is_active or (get_settings().require_verified_email and not user.email_verified):
        return None
    if int(claims.get("tv", 0)) != int(user.token_version or 0):
        return None
    return user
