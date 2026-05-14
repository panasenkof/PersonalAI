from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.schemas import LLMSettingsIn, LLMSettingsOut
from app.db import get_session
from app.models import LLMSettings, User
from app.security.crypto import encrypt_api_key

router = APIRouter(prefix="/v1/settings", tags=["settings"])


@router.get("/llm", response_model=LLMSettingsOut)
async def get_llm(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> LLMSettingsOut:
    row = await session.get(LLMSettings, user.id)
    if not row:
        raise HTTPException(status_code=500, detail="llm settings missing")
    return LLMSettingsOut(
        provider_kind=row.provider_kind,
        base_url=row.base_url,
        default_model=row.default_model,
        embedding_model=row.embedding_model,
        supports_vision=row.supports_vision,
    )


@router.patch("/llm", response_model=LLMSettingsOut)
async def patch_llm(
    body: LLMSettingsIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> LLMSettingsOut:
    row = await session.get(LLMSettings, user.id)
    if not row:
        raise HTTPException(status_code=500, detail="llm settings missing")
    row.provider_kind = body.provider_kind
    row.base_url = body.base_url
    row.default_model = body.default_model
    row.embedding_model = body.embedding_model
    row.supports_vision = body.supports_vision
    if body.api_key is not None:
        ct, plain = encrypt_api_key(body.api_key)
        row.api_key_ciphertext = ct
        row.api_key_plain = plain
    await session.commit()
    await session.refresh(row)
    return LLMSettingsOut(
        provider_kind=row.provider_kind,
        base_url=row.base_url,
        default_model=row.default_model,
        embedding_model=row.embedding_model,
        supports_vision=row.supports_vision,
    )
