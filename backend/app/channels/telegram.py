from __future__ import annotations

import hmac
import logging
from typing import Any

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
    reply_text_for,
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

router = APIRouter(prefix="/v1/channels/telegram", tags=["telegram"])

TG_MESSAGE_LIMIT = 4000  # Telegram hard limit is 4096 characters
FILE_TOO_LARGE_TEXT = "Файл слишком большой."


def _verify_webhook_secret(x_secret: str | None) -> None:
    expected = get_settings().telegram_webhook_secret
    if not require_webhook_secret(expected, "telegram"):
        return
    if not hmac.compare_digest((x_secret or "").encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="invalid_webhook_secret")


def _detect_mime(path: str, hint: str | None = None) -> str:
    if hint:
        return hint
    lower = path.lower()
    for suffix, mime in (
        (".png", "image/png"),
        (".webp", "image/webp"),
        ((".oga", ".ogg", ".opus"), "audio/ogg"),
        (".mp3", "audio/mpeg"),
        (".m4a", "audio/mp4"),
        (".pdf", "application/pdf"),
        ((".txt", ".md"), "text/plain"),
        (".csv", "text/csv"),
    ):
        if lower.endswith(suffix):
            return mime
    return "image/jpeg"


async def _download_tg_file(file_id: str, mime_hint: str | None = None) -> tuple[bytes, str]:
    token = get_settings().telegram_bot_token
    if not token:
        raise HTTPException(500, detail="telegram_bot_token not configured")
    r = await request_json(
        "GET", f"https://api.telegram.org/bot{token}/getFile", params={"file_id": file_id}, label="telegram/getFile"
    )
    path = r.json()["result"]["file_path"]
    fr = await request_json(
        "GET", f"https://api.telegram.org/file/bot{token}/{path}", timeout=60.0, label="telegram/file"
    )
    return fr.content, _detect_mime(path, mime_hint)


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    code, exp = await issue_link_code(session, user)
    return {"code": code, "expires_at": exp.isoformat(), "instructions": "Send /start CODE to the bot from your Telegram account."}


async def _tg_api(method: str, payload: dict[str, Any]) -> None:
    token = get_settings().telegram_bot_token
    if not token:
        return
    await request_json("POST", f"https://api.telegram.org/bot{token}/{method}", json=payload, label=f"telegram/{method}")


def _chunks(text: str, limit: int = TG_MESSAGE_LIMIT) -> list[str]:
    text = text or ""
    return [text[i : i + limit] for i in range(0, len(text), limit)] or [""]


async def send_telegram_message(chat_id: int, text: str, reply_markup: dict[str, Any] | None = None) -> None:
    payload: dict[str, Any] = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    await _tg_api("sendMessage", payload)


def _fact_keyboard(fact_id: str) -> dict[str, Any]:
    return {
        "inline_keyboard": [
            [
                {"text": "✅ Подтвердить", "callback_data": fact_callback_data("confirm", fact_id)},
                {"text": "❌ Отклонить", "callback_data": fact_callback_data("reject", fact_id)},
            ]
        ]
    }


async def reply(env: IngestionEnvelope, text: str, facts: list[dict[str, Any]]) -> None:
    """Answer in the originating chat: text (split if long) + one confirm/reject prompt per pending fact."""
    chat_id = (env.channel_meta or {}).get("chat_id")
    if not chat_id:
        return
    for part in _chunks(str(text)):
        await send_telegram_message(chat_id=int(chat_id), text=part)
    for fact in facts:
        await send_telegram_message(
            chat_id=int(chat_id),
            text=f"📝 Проверьте распознанные данные:\n{fact.get('summary') or fact.get('kind')}",
            reply_markup=_fact_keyboard(fact["id"]),
        )


async def _handle_callback(session: AsyncSession, cq: dict[str, Any]) -> None:
    tg_id = str((cq.get("from") or {}).get("id") or "")
    parsed = parse_fact_callback(cq.get("data") or "")
    msg = cq.get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    user = await user_by_channel_id(session, "telegram_user_id", tg_id) if tg_id else None
    if parsed is None or user is None:
        await _tg_api("answerCallbackQuery", {"callback_query_id": cq.get("id"), "text": "Недоступно"})
        return
    result_text = await apply_fact_action(session, user, parsed[0], parsed[1])
    await _tg_api("answerCallbackQuery", {"callback_query_id": cq.get("id"), "text": result_text[:190]})
    if chat_id and msg.get("message_id"):
        # replace the prompt (this also removes the inline keyboard)
        await _tg_api(
            "editMessageText",
            {"chat_id": chat_id, "message_id": msg["message_id"], "text": result_text[:TG_MESSAGE_LIMIT]},
        )


async def _collect_attachments(session: AsyncSession, user: User, msg: dict[str, Any]) -> tuple[list[Attachment], bool]:
    """Download photo / document (PDF etc.) / voice from the message. Returns (attachments, too_large)."""
    limit = getattr(get_settings(), "max_upload_bytes", 20 * 1024 * 1024)
    attachments: list[Attachment] = []

    async def _add(file_id: str, filename: str, mime_hint: str | None = None, plain: bool = False) -> bool:
        data, mime = await (_download_tg_file(file_id) if plain else _download_tg_file(file_id, mime_hint))
        if len(data) > limit:
            return False
        blob = await store_blob(session, user.id, data, mime, filename=filename)
        attachments.append(Attachment(mime=mime, storage_key=blob.storage_key, filename=filename))
        return True

    if msg.get("photo"):
        best = msg["photo"][-1]
        if not await _add(best["file_id"], "telegram_photo.jpg", plain=True):
            return attachments, True
    elif msg.get("document"):
        doc = msg["document"]
        name = doc.get("file_name") or "document"
        if not await _add(doc["file_id"], name, doc.get("mime_type")):
            return attachments, True
    else:
        audio = msg.get("voice") or msg.get("audio")
        if audio:
            # voice notes → audio attachment; pipeline transcribes via STT when configured
            if not await _add(audio["file_id"], "telegram_voice", plain=True):
                return attachments, True
    return attachments, False


@router.post("/webhook")
async def telegram_webhook(
    update: dict[str, Any],
    session: AsyncSession = Depends(get_session),
    x_telegram_bot_api_secret_token: str | None = Header(None, alias="X-Telegram-Bot-Api-Secret-Token"),
) -> dict[str, str]:
    _verify_webhook_secret(x_telegram_bot_api_secret_token)
    if update.get("callback_query"):
        await _handle_callback(session, update["callback_query"])
        return {"ok": "true"}
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return {"ok": "true"}
    from_user = msg.get("from") or {}
    tg_id = str(from_user.get("id") or "")
    chat_id = int(msg["chat"]["id"]) if (msg.get("chat") or {}).get("id") is not None else None
    text = msg.get("text") or msg.get("caption") or ""

    if text.startswith("/start "):
        user = await pair_account(session, text.split(maxsplit=1)[1], "telegram_user_id", tg_id)
        if user and chat_id is not None:
            await send_telegram_message(chat_id=chat_id, text="Аккаунт привязан. Можно отправлять сообщения.")
        return {"ok": "true"}

    user = await user_by_channel_id(session, "telegram_user_id", tg_id)
    if not user:
        return {"ok": "true"}

    external_ref = f"telegram:{chat_id}"
    command = text.split(maxsplit=1)[0].split("@")[0].lower() if text.startswith("/") else ""
    if command == "/stop":
        stopped = await cancel_latest_job(session, user.id)
        if chat_id is not None:
            await send_telegram_message(chat_id=chat_id, text="Остановлено." if stopped else "Нет активных задач.")
        return {"ok": "true"}
    if command == "/new":
        await start_new_conversation(session, user.id, "telegram", external_ref)
        if chat_id is not None:
            await send_telegram_message(chat_id=chat_id, text="Начат новый диалог.")
        return {"ok": "true"}

    attachments, too_large = await _collect_attachments(session, user, msg)
    if too_large:
        await session.commit()
        if chat_id is not None:
            await send_telegram_message(chat_id=chat_id, text=FILE_TOO_LARGE_TEXT)
        return {"ok": "true"}

    env = IngestionEnvelope(
        text=text or None,
        attachments=attachments,
        channel=Channel.telegram,
        correlation_id=f"tg:{chat_id}:{msg.get('message_id')}",
        external_ref=external_ref,
        channel_meta={"chat_id": chat_id},
    )
    try:
        out = await submit_envelope(session, user, env)
        if out is not None:  # sync mode: answer inline
            await reply(env, reply_text_for(out), out.get("pending_facts") or [])
    except DuplicateDelivery:
        await session.rollback()  # Telegram retried a webhook we already handled
    except RateLimitExceeded:
        await session.rollback()
        if chat_id is not None:
            await send_telegram_message(chat_id=chat_id, text=RATE_LIMITED_TEXT)
    except Exception as exc:  # noqa: BLE001
        await session.rollback()
        if chat_id is not None:
            await send_telegram_message(chat_id=chat_id, text=f"Ошибка: {safe_error(exc)}"[:TG_MESSAGE_LIMIT])
    return {"ok": "true"}
