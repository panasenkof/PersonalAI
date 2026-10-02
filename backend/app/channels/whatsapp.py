"""WhatsApp Cloud API channel (Meta): webhook verification, HMAC-signed events, media, buttons."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
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
    require_webhook_secret,
    start_new_conversation,
    submit_envelope,
    user_by_channel_id,
)
from app.config import get_settings
from app.db import get_session
from app.ingestion.schemas import Attachment, Channel, IngestionEnvelope
from app.llm.limits import RateLimitExceeded
from app.models import User
from app.net.retry import request_json
from app.security.redact import safe_error
from app.services.blobs import store_blob

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/channels/whatsapp", tags=["whatsapp"])

GRAPH = "https://graph.facebook.com/v20.0"
WA_TEXT_LIMIT = 4000


def verify_signature(body: bytes, signature: str | None, app_secret: str) -> bool:
    """X-Hub-Signature-256: sha256=<hex hmac of raw body with the app secret>."""
    if not signature or not app_secret or not signature.startswith("sha256="):
        return False
    digest = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={digest}", signature)


async def _post_message(to: str, payload: dict[str, Any]) -> None:
    s = get_settings()
    if not s.whatsapp_access_token or not s.whatsapp_phone_number_id:
        raise RuntimeError("whatsapp_not_configured")
    body = {"messaging_product": "whatsapp", "to": to, **payload}
    await request_json(
        "POST",
        f"{GRAPH}/{s.whatsapp_phone_number_id}/messages",
        headers={"Authorization": f"Bearer {s.whatsapp_access_token}"},
        json=body,
        label="whatsapp/messages",
    )


async def send_whatsapp_message(to: str, text: str) -> None:
    for i in range(0, max(len(text), 1), WA_TEXT_LIMIT):
        await _post_message(to, {"type": "text", "text": {"body": text[i : i + WA_TEXT_LIMIT]}})


async def send_whatsapp_buttons(to: str, body: str, fact_id: str) -> None:
    await _post_message(
        to,
        {
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": {"text": body[:1000]},
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": fact_callback_data("confirm", fact_id), "title": "✅ Подтвердить"}},
                        {"type": "reply", "reply": {"id": fact_callback_data("reject", fact_id), "title": "❌ Отклонить"}},
                    ]
                },
            },
        },
    )


async def reply(env: IngestionEnvelope, text: str, facts: list[dict[str, Any]]) -> None:
    to = (env.channel_meta or {}).get("chat_id")
    if not to:
        return
    await send_whatsapp_message(str(to), text)
    for fact in facts:
        await send_whatsapp_buttons(str(to), f"Проверьте распознанные данные:\n{fact.get('summary')}", fact["id"])


async def _download_media(media_id: str) -> tuple[bytes, str]:
    token = get_settings().whatsapp_access_token
    headers = {"Authorization": f"Bearer {token}"}
    meta = (await request_json("GET", f"{GRAPH}/{media_id}", headers=headers, label="whatsapp/media-meta")).json()
    fr = await request_json("GET", meta["url"], headers=headers, timeout=60.0, label="whatsapp/media")
    return fr.content, meta.get("mime_type") or "application/octet-stream"


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    code, exp = await issue_link_code(session, user)
    return {"code": code, "expires_at": exp.isoformat(), "instructions": "Send /start CODE to the WhatsApp number."}


@router.get("/webhook")
async def verify_webhook(
    hub_mode: str | None = Query(None, alias="hub.mode"),
    hub_verify_token: str | None = Query(None, alias="hub.verify_token"),
    hub_challenge: str | None = Query(None, alias="hub.challenge"),
) -> PlainTextResponse:
    """Meta's subscription handshake."""
    expected = get_settings().whatsapp_verify_token
    if not expected:
        raise HTTPException(503, detail="whatsapp_verify_token_not_configured")
    if hub_mode == "subscribe" and hmac.compare_digest(hub_verify_token or "", expected):
        return PlainTextResponse(hub_challenge or "")
    raise HTTPException(403, detail="verification_failed")


async def _collect(session: AsyncSession, user: User, message: dict[str, Any]) -> list[Attachment]:
    limit = getattr(get_settings(), "max_upload_bytes", 20 * 1024 * 1024)
    mtype = message.get("type")
    node = message.get(mtype or "") if mtype in ("image", "document", "audio", "voice") else None
    if not node or not node.get("id"):
        return []
    data, mime = await _download_media(node["id"])
    if len(data) > limit:
        return []
    name = node.get("filename") or f"whatsapp_{mtype}"
    blob = await store_blob(session, user.id, data, node.get("mime_type") or mime, filename=name)
    return [Attachment(mime=blob.mime, storage_key=blob.storage_key, filename=name)]


async def _handle_message(session: AsyncSession, message: dict[str, Any]) -> None:
    wa_id = str(message.get("from") or "")
    if not wa_id:
        return
    mtype = message.get("type")
    interactive_id = None
    if mtype == "interactive":
        interactive_id = ((message.get("interactive") or {}).get("button_reply") or {}).get("id")
    text = (message.get("text") or {}).get("body") or ""
    if mtype in ("image", "document"):
        text = (message.get(mtype) or {}).get("caption") or ""

    if text.startswith("/start "):
        user = await pair_account(session, text.split(maxsplit=1)[1], "whatsapp_user_id", wa_id)
        await send_whatsapp_message(wa_id, "Аккаунт привязан ✔" if user else "Код недействителен или истёк.")
        return
    user = await user_by_channel_id(session, "whatsapp_user_id", wa_id)
    if user is None:
        await send_whatsapp_message(wa_id, "Сначала привяжите аккаунт: получите код в приложении и отправьте /start КОД.")
        return
    if interactive_id:
        parsed = parse_fact_callback(interactive_id)
        if parsed:
            await send_whatsapp_message(wa_id, await apply_fact_action(session, user, parsed[0], parsed[1]))
        return

    command = text.split(maxsplit=1)[0].lower() if text.startswith("/") else ""
    external_ref = f"whatsapp:{wa_id}"
    if command == "/stop":
        await send_whatsapp_message(wa_id, "Остановлено." if await cancel_latest_job(session, user.id) else "Нет активных задач.")
        return
    if command == "/new":
        await start_new_conversation(session, user.id, "whatsapp", external_ref)
        await send_whatsapp_message(wa_id, "Начат новый диалог.")
        return

    try:
        attachments = await _collect(session, user, message)
        env = IngestionEnvelope(
            text=text or None,
            attachments=attachments,
            channel=Channel.whatsapp,
            correlation_id=f"wa:{message.get('id')}" if message.get("id") else None,
            external_ref=external_ref,
            channel_meta={"chat_id": wa_id},
        )
        out = await submit_envelope(session, user, env)
        if out is not None:
            from app.queue.delivery import deliver_reply

            await deliver_reply(out["_delivery_job_id"])
    except DuplicateDelivery:
        await session.rollback()
    except RateLimitExceeded:
        await session.rollback()
        await send_whatsapp_message(wa_id, RATE_LIMITED_TEXT)
    except Exception as exc:  # noqa: BLE001
        await session.rollback()
        logger.warning("whatsapp handling failed: %s", exc)
        await send_whatsapp_message(wa_id, f"Ошибка: {safe_error(exc)}")


@router.post("/webhook")
async def receive(
    request: Request,
    x_hub_signature_256: str | None = Header(None, alias="X-Hub-Signature-256"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    body = await request.body()
    secret = get_settings().whatsapp_app_secret
    if require_webhook_secret(secret, "whatsapp") and not verify_signature(body, x_hub_signature_256, secret):
        raise HTTPException(status_code=401, detail="invalid_signature")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid_json") from None
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            for message in (change.get("value") or {}).get("messages") or []:
                await _handle_message(session, message)
    return {"status": "ok"}
