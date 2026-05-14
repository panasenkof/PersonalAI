from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.llm.providers import CloudLLMProvider, LLMProvider, LocalLLMProvider
from app.models import LLMSettings as LLMSettingsRow
from app.security.crypto import decrypt_api_key


async def provider_for_user(session: AsyncSession, user_id: str, settings: Settings | None = None) -> LLMProvider:
    settings = settings or get_settings()
    row = await session.get(LLMSettingsRow, user_id)
    if row is None:
        # Defaults for new users
        return CloudLLMProvider(base_url="https://api.openai.com/v1", api_key=None)
    api_key = decrypt_api_key(row.api_key_ciphertext, row.api_key_plain)
    base = row.base_url or "https://api.openai.com/v1"
    if row.provider_kind == "local":
        return LocalLLMProvider(base_url=base, api_key=api_key)
    return CloudLLMProvider(base_url=base, api_key=api_key)


async def llm_settings_row(session: AsyncSession, user_id: str) -> LLMSettingsRow | None:
    return await session.get(LLMSettingsRow, user_id)


async def default_model_for_user(session: AsyncSession, user_id: str) -> str:
    row = await session.get(LLMSettingsRow, user_id)
    if row and row.default_model:
        return row.default_model
    return "gpt-4o-mini"
