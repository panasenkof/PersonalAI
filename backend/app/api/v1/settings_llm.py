from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.schemas import LLMSettingsIn, LLMSettingsOut
from app.config import get_settings
from app.db import get_session
from app.models import User
from app.security.crypto import decrypt_api_key, encrypt_api_key
from app.security.endpoints import validate_llm_endpoint
from app.services.users import get_or_create_llm_settings

router = APIRouter(prefix="/v1/settings", tags=["settings"])


def _out(row) -> LLMSettingsOut:
    s = get_settings()
    return LLMSettingsOut(
        api_key_configured=bool(decrypt_api_key(row.api_key_ciphertext, row.api_key_plain) or (row.base_url == s.default_llm_base_url and s.default_llm_api_key)),
        provider_kind=row.provider_kind,
        base_url=row.base_url,
        default_model=row.default_model,
        embedding_model=row.embedding_model,
        supports_vision=row.supports_vision,
    )


@router.get("/llm", response_model=LLMSettingsOut)
async def get_llm(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> LLMSettingsOut:
    row = await get_or_create_llm_settings(session, user.id)
    await session.commit()
    return _out(row)


@router.patch("/llm", response_model=LLMSettingsOut)
async def patch_llm(
    body: LLMSettingsIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> LLMSettingsOut:
    row = await get_or_create_llm_settings(session, user.id)
    try:
        endpoint = validate_llm_endpoint(body.base_url)
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from None
    s = get_settings()
    own_key = body.api_key if body.api_key is not None else decrypt_api_key(row.api_key_ciphertext, row.api_key_plain)
    if not own_key and s.default_llm_api_key and endpoint == s.default_llm_base_url and (body.default_model != s.default_llm_model or body.embedding_model not in (None, s.default_embedding_model)):
        raise HTTPException(422, detail='Для ключа оператора доступны только настроенные им модели. Для другой модели укажите собственный ключ.')
    row.provider_kind = body.provider_kind
    row.base_url = endpoint
    row.default_model = body.default_model
    row.embedding_model = body.embedding_model
    row.supports_vision = body.supports_vision
    if body.api_key is not None:
        ct, plain = encrypt_api_key(body.api_key)
        row.api_key_ciphertext = ct
        row.api_key_plain = plain
    await session.commit()
    await session.refresh(row)
    return _out(row)


@router.post('/llm/test')
async def test_connection(session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)) -> dict:
    import asyncio

    from app.llm.admission import reserve_request
    from app.llm.limits import RateLimitExceeded, check_user_quota
    from app.llm.providers import ChatMessage
    from app.llm.router import provider_for_user

    row = await get_or_create_llm_settings(session, user.id)
    try:
        await check_user_quota(user.id)
        await reserve_request(session, user.id, job=False)
        await session.commit()
        provider = await provider_for_user(session, user.id)
        async with asyncio.timeout(25):
            await provider.chat([ChatMessage(role='user', content='Reply with OK only.')], model=row.default_model, tools=None)
            embeddings = False
            if row.embedding_model:
                vectors = await provider.embed(['Connection check'], model=row.embedding_model)
                embeddings = bool(vectors and vectors[0])
                if not embeddings:
                    raise ValueError('empty embeddings')
    except RateLimitExceeded as exc:
        raise HTTPException(429, detail=exc.reason, headers={'Retry-After': str(exc.retry_after)}) from None
    except Exception:  # noqa: BLE001 — provider errors can contain credentials; do not return them
        raise HTTPException(502, detail='Проверка не прошла. Проверьте модель, адрес, ключ и лимиты провайдера.') from None
    await session.commit()
    return {'chat': True, 'embeddings': embeddings, 'message': 'Модель отвечает.' + (' Эмбеддинги работают.' if embeddings else ' Модель эмбеддингов не настроена; поиск доступен по тексту.')}
