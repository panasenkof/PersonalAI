"""MAX Bot API: private conversations, account linking, media and fact buttons."""

from __future__ import annotations

import asyncio
import hmac
import mimetypes
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
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
from app.security.ratelimit import AsyncLimiter, build_limiter
from app.security.redact import safe_error
from app.services.blobs import store_blob

router = APIRouter(prefix="/v1/channels/max", tags=["max"])
MESSAGE_LIMIT = 4000
_send_limiter: AsyncLimiter | None = None


async def _wait_for_send_slot(user_id: int) -> None:
    # Use a conservative one-message-per-second window per dialog. Redis coordinates replicas.
    global _send_limiter
    if _send_limiter is None:
        _send_limiter = build_limiter("max-send", 1, 1)
    while not await _send_limiter.allow(str(user_id)):
        await asyncio.sleep(0.55)


async def _max_api(path: str, payload: dict[str, Any], **params: Any) -> None:
    s = get_settings()
    if not s.max_bot_token:
        raise RuntimeError("MAX_BOT_TOKEN is not configured")
    if path == "messages" and "user_id" in params:
        await _wait_for_send_slot(int(params["user_id"]))
    response = await request_json(
        "POST",
        f"{s.max_api_base_url.rstrip('/')}/{path}",
        headers={"Authorization": s.max_bot_token},
        params=params,
        json=payload,
        label=f"max/{path}",
    )
    if response.json().get("success") is False:
        raise RuntimeError("MAX API rejected the request")


async def send_max_message(user_id: int, text: str, attachments: list[dict[str, Any]] | None = None) -> None:
    for i in range(0, max(len(text), 1), MESSAGE_LIMIT):
        payload: dict[str, Any] = {"text": text[i : i + MESSAGE_LIMIT] or "Готово."}
        if attachments and i + MESSAGE_LIMIT >= len(text):
            payload["attachments"] = attachments
        await _max_api("messages", payload, user_id=user_id)


def _fact_keyboard(fact_id: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "inline_keyboard",
            "payload": {
                "buttons": [
                    [
                        {
                            "type": "callback",
                            "text": "✅ Подтвердить",
                            "payload": fact_callback_data("confirm", fact_id),
                        },
                        {"type": "callback", "text": "❌ Отклонить", "payload": fact_callback_data("reject", fact_id)},
                    ]
                ]
            },
        }
    ]


async def reply(env: IngestionEnvelope, text: str, facts: list[dict[str, Any]]) -> None:
    user_id = (env.channel_meta or {}).get("user_id")
    if user_id is None:
        return
    await send_max_message(int(user_id), text)
    for fact in facts:
        await send_max_message(
            int(user_id),
            f"📝 Проверьте распознанные данные:\n{fact.get('summary') or fact.get('kind')}",
            _fact_keyboard(fact["id"]),
        )


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    code, exp = await issue_link_code(session, user)
    return {
        "code": code,
        "expires_at": exp.isoformat(),
        "instructions": "Отправьте /start КОД в личном диалоге с ботом MAX.",
    }


class MediaTooLarge(ValueError):
    pass


def _media_url(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    allowed = [h.strip().lower() for h in get_settings().max_media_allowed_hosts.split(",") if h.strip()]
    if (
        parts.scheme != "https"
        or parts.username
        or parts.password
        or parts.port not in (None, 443)
        or not any(host == h or host.endswith("." + h) for h in allowed)
    ):
        raise ValueError("MAX media URL is not allowed")
    return url


async def _download_media(url: str) -> tuple[bytes, str]:
    # Never send bot credentials to media URLs; never follow redirects to untrusted hosts.
    url = _media_url(url)
    limit = get_settings().max_upload_bytes
    async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError("MAX media redirect is not allowed")
            if int(response.headers.get("content-length", "0")) > limit:
                raise MediaTooLarge()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > limit:
                    raise MediaTooLarge()
            return bytes(data), response.headers.get("content-type", "application/octet-stream").split(";")[0]


async def _collect_attachments(session: AsyncSession, user: User, body: dict[str, Any]) -> list[Attachment]:
    attachments = []
    for item in body.get("attachments") or []:
        kind = item.get("type")
        if kind not in ("image", "audio", "file"):
            continue
        payload = item.get("payload") or {}
        if not payload.get("url"):
            raise ValueError("MAX attachment has no download URL")
        data, mime = await _download_media(payload["url"])
        if len(data) > get_settings().max_upload_bytes:
            raise MediaTooLarge()
        name = item.get("filename") or payload.get("filename") or f"max_{kind}"
        if mime == "application/octet-stream":
            mime = mimetypes.guess_type(name)[0] or (
                "image/jpeg" if kind == "image" else "audio/mpeg" if kind == "audio" else mime
            )
        blob = await store_blob(session, user.id, data, mime, filename=name)
        attachments.append(Attachment(mime=blob.mime, storage_key=blob.storage_key, filename=name))
    return attachments


async def _handle_callback(session: AsyncSession, update: dict[str, Any]) -> None:
    callback = update.get("callback") or {}
    sender = callback.get("user") or {}
    if sender.get("user_id") is None or not callback.get("callback_id"):
        return
    recipient = ((update.get("message") or {}).get("recipient") or {})
    if recipient.get("chat_type") in ("chat", "channel"):
        await _max_api("answers", {}, callback_id=callback["callback_id"])
        return
    user = await user_by_channel_id(session, "max_user_id", str(sender["user_id"]))
    parsed = parse_fact_callback(callback.get("payload") or "")
    result = await apply_fact_action(session, user, *parsed) if user and parsed else "Недоступно"
    # Do not edit another user's prompt when access was denied.
    if user and parsed and result != "Запись не найдена.":
        await _max_api(
            "answers",
            {"message": {"text": result[:MESSAGE_LIMIT], "attachments": []}},
            callback_id=callback["callback_id"],
        )
    else:
        await send_max_message(int(sender["user_id"]), result)
        await _max_api("answers", {}, callback_id=callback["callback_id"])


@router.post("/webhook")
async def max_webhook(
    update: dict[str, Any],
    session: AsyncSession = Depends(get_session),
    secret: str | None = Header(None, alias="X-Max-Bot-Api-Secret"),
) -> dict[str, str]:
    expected = get_settings().max_webhook_secret
    if require_webhook_secret(expected, "max") and not hmac.compare_digest((secret or "").encode(), expected.encode()):
        raise HTTPException(401, detail="invalid_webhook_secret")
    kind = update.get("update_type")
    if kind == "message_callback":
        await _handle_callback(session, update)
        return {"ok": "true"}
    if kind == "bot_started":
        sender = update.get("user") or {}
        body = {"text": f"/start {update['payload']}" if update.get("payload") else "/start"}
        chat_id = update.get("chat_id")
    elif kind == "message_created":
        msg = update.get("message") or {}
        recipient = msg.get("recipient") or {}
        # Personal assistant data and linking codes must stay in a private dialog.
        if recipient.get("chat_type") != "dialog":
            return {"ok": "true"}
        sender, body, chat_id = msg.get("sender") or {}, msg.get("body") or {}, recipient.get("chat_id")
    else:
        return {"ok": "true"}
    external_id = sender.get("user_id")
    if external_id is None or sender.get("is_bot"):
        return {"ok": "true"}
    text = body.get("text") or ""
    if text.startswith("/start "):
        user = await pair_account(session, text.split(maxsplit=1)[1], "max_user_id", str(external_id))
        await send_max_message(
            int(external_id),
            "Аккаунт привязан. Можно отправлять сообщения." if user else "Код недействителен или истёк.",
        )
        return {"ok": "true"}
    user = await user_by_channel_id(session, "max_user_id", str(external_id))
    if user is None:
        await send_max_message(int(external_id), "Получите код в настройках приложения и отправьте /start КОД.")
        return {"ok": "true"}
    ref = f"max:{external_id}"
    command = text.split(maxsplit=1)[0].lower() if text.startswith("/") else ""
    if command == "/start":
        await send_max_message(
            int(external_id),
            "Аккаунт уже привязан. Отправьте сообщение, фото, документ или аудио. /new — новый диалог, /stop — остановить задачу.",
        )
        return {"ok": "true"}
    if command == "/new":
        await start_new_conversation(session, user.id, "max", ref)
        await send_max_message(int(external_id), "Начат новый диалог.")
        return {"ok": "true"}
    if command == "/stop":
        stopped = await cancel_latest_job(session, user.id)
        await send_max_message(int(external_id), "Остановлено." if stopped else "Нет активных задач.")
        return {"ok": "true"}
    if not body.get("mid"):
        raise HTTPException(400, detail="missing_message_id")
    try:
        attachments = await _collect_attachments(session, user, body)
        if not text and not attachments:
            await send_max_message(int(external_id), "Отправьте текст, фото, документ или аудио.")
            return {"ok": "true"}
        env = IngestionEnvelope(
            text=text or None,
            attachments=attachments,
            channel=Channel.max,
            correlation_id=f"max:{external_id}:{body['mid']}",
            external_ref=ref,
            channel_meta={"user_id": external_id, "chat_id": chat_id},
        )
        out = await submit_envelope(session, user, env)
        if out is not None:
            from app.queue.delivery import deliver_reply

            await deliver_reply(out["_delivery_job_id"])
    except DuplicateDelivery:
        await session.rollback()
    except MediaTooLarge:
        await session.rollback()
        await send_max_message(int(external_id), "Файл слишком большой.")
    except RateLimitExceeded:
        await session.rollback()
        await send_max_message(int(external_id), RATE_LIMITED_TEXT)
    except Exception as exc:
        await session.rollback()
        await send_max_message(int(external_id), f"Ошибка: {safe_error(exc)}"[:MESSAGE_LIMIT])
    return {"ok": "true"}
