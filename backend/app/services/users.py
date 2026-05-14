from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Collection, LLMSettings, User


async def bootstrap_user(session: AsyncSession, email: str, password_hash: str) -> User:
    user = User(email=email, password_hash=password_hash)
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
