from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.llm.providers import CloudLLMProvider, LLMProvider, LocalLLMProvider
from app.models import LLMSettings as LLMSettingsRow
from app.security.crypto import decrypt_api_key
from app.services.users import get_or_create_llm_settings


async def provider_for_user(session: AsyncSession, user_id: str, settings: Settings | None = None) -> LLMProvider:
    settings = settings or get_settings()
    row = await get_or_create_llm_settings(session, user_id)
    api_key = decrypt_api_key(row.api_key_ciphertext, row.api_key_plain)
    base = row.base_url or "https://api.openai.com/v1"
    if row.provider_kind == "local":
        return LocalLLMProvider(base_url=base, api_key=api_key)
    return CloudLLMProvider(base_url=base, api_key=api_key)


async def llm_settings_row(session: AsyncSession, user_id: str) -> LLMSettingsRow | None:
    return await session.get(LLMSettingsRow, user_id)


async def default_model_for_user(session: AsyncSession, user_id: str) -> str:
    row = await get_or_create_llm_settings(session, user_id)
    if row and row.default_model:
        return row.default_model
    return "gpt-4o-mini"


def local_fallback_target(settings: Settings | None = None) -> tuple[LLMProvider, str] | None:
    """Cloud provider/model used when local LLM fails and LLM_ALLOW_LOCAL_FALLBACK=true."""
    settings = settings or get_settings()
    if not settings.llm_allow_local_fallback or not settings.fallback_base_url:
        return None
    provider = CloudLLMProvider(base_url=settings.fallback_base_url, api_key=settings.fallback_api_key or None)
    return provider, settings.fallback_model
