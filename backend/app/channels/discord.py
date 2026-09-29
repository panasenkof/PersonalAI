"""Discord channel via the Interactions endpoint (slash commands + buttons), no gateway bot needed.

Commands (register with `python -m app.channels.discord_register`):
  /ask text:<string> [file:<attachment>]   talk to the agent
  /link code:<string>                      bind this Discord account to your PIA account
  /stop                                    cancel the running request
  /new                                     start a new conversation
"""

from __future__ import annotations

import json
import logging
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.channels.common import (
    RATE_LIMITED_TEXT,
    DuplicateDelivery,
    apply_fact_action,
    cancel_latest_job,
    fact_callback_data,
    issue_link_code,
    pair_account,
    parse_fact_callback,
    reply_text_for,
    require_webhook_secret,
    start_new_conversation,
    submit_envelope,
    user_by_channel_id,
)
from app.config import get_settings
from app.db import SessionLocal, get_session
from app.ingestion.schemas import Attachment, Channel, IngestionEnvelope
from app.llm.limits import RateLimitExceeded
from app.models import User
from app.net.retry import request_json
from app.services.blobs import store_blob

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/channels/discord", tags=["discord"])

API = "https://discord.com/api/v10"
DISCORD_LIMIT = 1900  # hard limit is 2000

# interaction types / response types
PING, APPLICATION_COMMAND, MESSAGE_COMPONENT = 1, 2, 3
PONG, DEFERRED_MESSAGE, UPDATE_MESSAGE, CHANNEL_MESSAGE = 1, 5, 7, 4
EPHEMERAL = 64


def verify_signature(public_key_hex: str, signature_hex: str | None, timestamp: str | None, body: bytes) -> bool:
    if not (public_key_hex and signature_hex and timestamp):
        return False
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex)).verify(
            bytes.fromhex(signature_hex), timestamp.encode() + body
        )
        return True
    except (InvalidSignature, ValueError):
        return False


def _chunks(text: str, limit: int = DISCORD_LIMIT) -> list[str]:
    return [text[i : i + limit] for i in range(0, len(text), limit)] or [""]


def _fact_components(fact_id: str) -> list[dict[str, Any]]:
    return [
        {
            "type": 1,
            "components": [
                {"type": 2, "style": 3, "label": "Подтвердить", "custom_id": fact_callback_data("confirm", fact_id)},
                {"type": 2, "style": 4, "label": "Отклонить", "custom_id": fact_callback_data("reject", fact_id)},
            ],
        }
    ]


async def _followup(app_id: str, token: str, payload: dict[str, Any], *, first: bool) -> None:
    """First message edits the deferred 'thinking…' placeholder, later ones are new follow-ups."""
    if first:
        await request_json(
            "PATCH", f"{API}/webhooks/{app_id}/{token}/messages/@original", json=payload, label="discord/edit"
        )
    else:
        await request_json("POST", f"{API}/webhooks/{app_id}/{token}", json=payload, label="discord/followup")


async def reply(env: IngestionEnvelope, text: str, facts: list[dict[str, Any]]) -> None:
    meta = env.channel_meta or {}
    token, app_id = meta.get("interaction_token"), meta.get("application_id")
    if not token or not app_id:
        return
    first = True
    for part in _chunks(str(text)):
        await _followup(app_id, token, {"content": part}, first=first)
        first = False
    for fact in facts:
        await _followup(
            app_id,
            token,
            {
                "content": f"📝 Проверьте распознанные данные:\n{fact.get('summary')}"[:DISCORD_LIMIT],
                "components": _fact_components(fact["id"]),
            },
            first=first,
        )
        first = False


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    code, exp = await issue_link_code(session, user)
    return {"code": code, "expires_at": exp.isoformat(), "instructions": "In Discord run: /link code:CODE"}


def _options(data: dict[str, Any]) -> dict[str, Any]:
    return {o["name"]: o.get("value") for o in (data.get("options") or []) if "name" in o}


def _discord_user_id(inter: dict[str, Any]) -> str:
    u = (inter.get("member") or {}).get("user") or inter.get("user") or {}
    return str(u.get("id") or "")


async def _process_ask(inter: dict[str, Any], user_id: str, text: str, attach_id: str | None) -> None:
    """Background: fetch the attachment, run the agent, answer through the interaction webhook."""
    meta = {"interaction_token": inter.get("token"), "application_id": inter.get("application_id")
            or get_settings().discord_application_id, "chat_id": inter.get("channel_id")}
    channel_id = inter.get("channel_id") or user_id
    async with SessionLocal() as session:
        user = await session.get(User, user_id)
        if user is None:
            return
        env = IngestionEnvelope(
            text=text or None,
            channel=Channel.discord,
            correlation_id=f"discord:{inter.get('id')}",
            external_ref=f"discord:{channel_id}:{_discord_user_id(inter)}",
            channel_meta=meta,
        )
        try:
            if attach_id:
                att = ((inter.get("data") or {}).get("resolved") or {}).get("attachments", {}).get(attach_id)
                if att and att.get("url"):
                    limit = getattr(get_settings(), "max_upload_bytes", 20 * 1024 * 1024)
                    if int(att.get("size") or 0) <= limit:
                        r = await request_json("GET", att["url"], timeout=60.0, label="discord/attachment")
                        mime = att.get("content_type") or "application/octet-stream"
                        blob = await store_blob(session, user.id, r.content, mime, filename=att.get("filename"))
                        env.attachments.append(
                            Attachment(mime=mime, storage_key=blob.storage_key, filename=att.get("filename"))
                        )
            out = await submit_envelope(session, user, env)
            if out is not None:
                await reply(env, reply_text_for(out), out.get("pending_facts") or [])
        except DuplicateDelivery:
            await session.rollback()
        except RateLimitExceeded:
            await session.rollback()
            await _safe_edit(meta, RATE_LIMITED_TEXT)
        except Exception as exc:  # noqa: BLE001
            await session.rollback()
            logger.warning("discord processing failed: %s", exc)
            await _safe_edit(meta, f"Ошибка: {exc}"[:DISCORD_LIMIT])


async def _safe_edit(meta: dict[str, Any], content: str) -> None:
    try:
        await _followup(meta["application_id"], meta["interaction_token"], {"content": content}, first=True)
    except Exception:  # noqa: BLE001
        logger.warning("discord edit failed", exc_info=True)


def _msg(content: str, ephemeral: bool = True) -> dict[str, Any]:
    return {"type": CHANNEL_MESSAGE, "data": {"content": content, "flags": EPHEMERAL if ephemeral else 0}}


@router.post("/interactions")
async def interactions(
    request: Request,
    background: BackgroundTasks,
    x_signature_ed25519: str | None = Header(None, alias="X-Signature-Ed25519"),
    x_signature_timestamp: str | None = Header(None, alias="X-Signature-Timestamp"),
    session: AsyncSession = Depends(get_session),
) -> JSONResponse:
    body = await request.body()
    key = get_settings().discord_public_key
    if require_webhook_secret(key, "discord") and not verify_signature(key, x_signature_ed25519, x_signature_timestamp, body):
        raise HTTPException(status_code=401, detail="invalid_request_signature")
    try:
        inter = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid_json") from None

    itype = inter.get("type")
    if itype == PING:
        return JSONResponse({"type": PONG})
    duid = _discord_user_id(inter)

    if itype == MESSAGE_COMPONENT:
        parsed = parse_fact_callback((inter.get("data") or {}).get("custom_id") or "")
        user = await user_by_channel_id(session, "discord_user_id", duid) if duid else None
        if parsed is None or user is None:
            return JSONResponse(_msg("Недоступно."))
        text = await apply_fact_action(session, user, parsed[0], parsed[1])
        return JSONResponse({"type": UPDATE_MESSAGE, "data": {"content": text[:DISCORD_LIMIT], "components": []}})

    if itype != APPLICATION_COMMAND:
        return JSONResponse(_msg("Неподдерживаемое действие."))

    data = inter.get("data") or {}
    name = data.get("name")
    opts = _options(data)
    if name == "link":
        user = await pair_account(session, str(opts.get("code") or ""), "discord_user_id", duid)
        return JSONResponse(_msg("Аккаунт привязан ✔" if user else "Код недействителен или истёк."))

    user = await user_by_channel_id(session, "discord_user_id", duid) if duid else None
    if user is None:
        return JSONResponse(_msg("Сначала привяжите аккаунт: получите код в приложении и выполните /link."))
    if name == "stop":
        stopped = await cancel_latest_job(session, user.id)
        return JSONResponse(_msg("Остановлено." if stopped else "Нет активных задач."))
    if name == "new":
        await start_new_conversation(
            session, user.id, "discord", f"discord:{inter.get('channel_id') or duid}:{duid}"
        )
        return JSONResponse(_msg("Начат новый диалог."))
    if name == "ask":
        # Discord needs an answer within 3 s: acknowledge now, work in the background.
        background.add_task(_process_ask, inter, user.id, str(opts.get("text") or ""), opts.get("file"))
        return JSONResponse({"type": DEFERRED_MESSAGE})
    return JSONResponse(_msg("Неизвестная команда."))
