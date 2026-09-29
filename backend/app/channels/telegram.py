from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.config import get_settings
from app.db import get_session
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import Attachment, Channel, IngestionEnvelope, utcnow
from app.models import IngestionJob, JobStatus, TelegramLinkCode, User
from app.services.blobs import store_blob

router = APIRouter(prefix="/v1/channels/telegram", tags=["telegram"])


def _aware(dt: datetime) -> datetime:
    """SQLite returns naive datetimes; normalize to UTC before comparing."""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _verify_webhook_secret(x_secret: str | None) -> None:
    expected = get_settings().telegram_webhook_secret
    if not expected:
        return
    if x_secret != expected:
        raise HTTPException(status_code=401, detail="invalid_webhook_secret")


async def _download_tg_file(file_id: str) -> tuple[bytes, str]:
    token = get_settings().telegram_bot_token
    if not token:
        raise HTTPException(500, detail="telegram_bot_token not configured")
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.get(f"https://api.telegram.org/bot{token}/getFile", params={"file_id": file_id})
        r.raise_for_status()
        data = r.json()
        path = data["result"]["file_path"]
        mime = "image/jpeg"
        if path.lower().endswith(".png"):
            mime = "image/png"
        fr = await client.get(f"https://api.telegram.org/file/bot{token}/{path}")
        fr.raise_for_status()
        return fr.content, mime


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    code = secrets.token_hex(4).upper()
    exp = utcnow() + timedelta(minutes=15)
    row = TelegramLinkCode(user_id=user.id, code=code, expires_at=exp)
    session.add(row)
    await session.commit()
    return {"code": code, "expires_at": exp.isoformat(), "instructions": "Send /start CODE to the bot from your Telegram account."}


@router.post("/webhook")
async def telegram_webhook(
    update: dict[str, Any],
    session: AsyncSession = Depends(get_session),
    x_telegram_bot_api_secret_token: str | None = Header(None, alias="X-Telegram-Bot-Api-Secret-Token"),
) -> dict[str, str]:
    _verify_webhook_secret(x_telegram_bot_api_secret_token)
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return {"ok": "true"}
    from_user = msg.get("from") or {}
    tg_id = str(from_user.get("id") or "")
    text = msg.get("text") or ""
    if text.startswith("/start "):
        code = text.split(maxsplit=1)[1].strip()
        res = await session.execute(
            select(TelegramLinkCode)
            .where(TelegramLinkCode.code == code)
            .where(TelegramLinkCode.consumed_at.is_(None))
        )
        link = res.scalar_one_or_none()
        if link and _aware(link.expires_at) >= utcnow():
            u = await session.get(User, link.user_id)
            if u:
                # A Telegram account may be linked to only one user: take it over
                # from any previous owner so re-pairing always works.
                res_prev = await session.execute(
                    select(User).where(User.telegram_user_id == tg_id)
                )
                prev = res_prev.scalar_one_or_none()
                if prev is not None and prev.id != u.id:
                    prev.telegram_user_id = None
                    await session.flush()  # clear UNIQUE before assigning the new owner
                u.telegram_user_id = tg_id
                link.consumed_at = utcnow()
                await session.commit()
                await _tg_send_message(chat_id=int(msg["chat"]["id"]), text="Аккаунт привязан. Можно отправлять сообщения.")
        return {"ok": "true"}

    res = await session.execute(select(User).where(User.telegram_user_id == tg_id))
    user = res.scalar_one_or_none()
    if not user:
        return {"ok": "true"}

    attachments: list[Attachment] = []
    if msg.get("photo"):
        photos = msg["photo"]
        best = photos[-1]
        data, mime = await _download_tg_file(best["file_id"])
        blob = await store_blob(session, user.id, data, mime, filename="telegram_photo.jpg")
        attachments.append(Attachment(mime=mime, storage_key=blob.storage_key, filename="telegram_photo.jpg"))
    env = IngestionEnvelope(
        text=text or None,
        attachments=attachments,
        channel=Channel.telegram,
        correlation_id=str(msg.get("message_id")),
    )
    job = IngestionJob(
        user_id=user.id,
        status=JobStatus.accepted.value,
        correlation_id=env.correlation_id,
        envelope=env.model_dump(mode="json"),
    )
    session.add(job)
    await session.flush()
    try:
        out = await process_envelope(session, user.id, job, env)
        await session.commit()
        reply = out.get("assistant_text") or "Готово."
        if out.get("failed"):
            reply = f"Ошибка: {out.get('error')}"
        await _tg_send_message(chat_id=int(msg["chat"]["id"]), text=str(reply)[:4000])
    except Exception as exc:  # noqa: BLE001
        await session.rollback()
        await _tg_send_message(chat_id=int(msg["chat"]["id"]), text=f"Ошибка: {exc}"[:4000])
    return {"ok": "true"}


async def _tg_send_message(chat_id: int, text: str) -> None:
    token = get_settings().telegram_bot_token
    if not token:
        return
    async with httpx.AsyncClient(timeout=30.0) as client:
        await client.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text},
        )
