from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.config import get_settings
from app.db import get_session
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import Channel, IngestionEnvelope, utcnow
from app.models import IngestionJob, JobStatus, TelegramLinkCode, User

router = APIRouter(prefix="/v1/channels/slack", tags=["slack"])

SIGNATURE_MAX_AGE_SECONDS = 60 * 5


def verify_slack_signature(
    timestamp: str | None, signature: str | None, body: bytes, secret: str
) -> bool:
    """HMAC-SHA256 v0 signature check per Slack docs (with replay window)."""
    if not timestamp or not signature or not secret:
        return False
    try:
        ts = int(float(timestamp))
    except ValueError:
        return False
    if abs(time.time() - ts) > SIGNATURE_MAX_AGE_SECONDS:
        return False
    basestring = b"v0:" + timestamp.encode() + b":" + body
    digest = hmac.new(secret.encode(), basestring, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"v0={digest}", signature)


def _verify(sig: str | None, timestamp: str | None, body: bytes) -> None:
    secret = get_settings().slack_signing_secret
    if not secret:
        return  # dev mode: disabled until SLACK_SIGNING_SECRET is configured
    if not verify_slack_signature(timestamp, sig, body, secret):
        raise HTTPException(status_code=401, detail="invalid_slack_signature")


async def send_slack_message(channel: str, text: str) -> None:
    token = get_settings().slack_bot_token
    if not token:
        return
    async with httpx.AsyncClient(timeout=30.0) as client:
        await client.post(
            "https://slack.com/api/chat.postMessage",
            headers={"Authorization": f"Bearer {token}"},
            json={"channel": channel, "text": text[:4000]},
        )


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Same link-code flow as Telegram: POST with JWT, then /start CODE in Slack."""
    import secrets
    from datetime import timedelta

    code = secrets.token_hex(4).upper()
    row = TelegramLinkCode(
        user_id=user.id,
        code=code,
        expires_at=utcnow() + timedelta(minutes=15),
    )
    session.add(row)
    await session.commit()
    return {
        "code": code,
        "expires_at": row.expires_at.isoformat(),
        "instructions": "Send /start CODE to the Slack bot in a DM.",
    }


async def _pair(session: AsyncSession, code: str, slack_user: str, channel: str) -> None:
    res = await session.execute(
        select(TelegramLinkCode)
        .where(TelegramLinkCode.code == code)
        .where(TelegramLinkCode.consumed_at.is_(None))
    )
    link = res.scalar_one_or_none()
    if link is None or _aware(link.expires_at) < utcnow():
        await send_slack_message(channel, "Код недействителен или истёк.")
        return
    u = await session.get(User, link.user_id)
    if u is None:
        return
    res_prev = await session.execute(select(User).where(User.slack_user_id == slack_user))
    prev = res_prev.scalar_one_or_none()
    if prev is not None and prev.id != u.id:
        prev.slack_user_id = None
        await session.flush()  # keep UNIQUE satisfied
    u.slack_user_id = slack_user
    link.consumed_at = utcnow()
    await session.commit()
    await send_slack_message(channel, "Аккаунт привязан ✔ Можно писать сообщения.")


@router.post("/events")
async def slack_events(
    request: Request,
    x_slack_signature: str | None = Header(None, alias="X-Slack-Signature"),
    x_slack_request_timestamp: str | None = Header(None, alias="X-Slack-Request-Timestamp"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    body = await request.body()
    _verify(x_slack_signature, x_slack_request_timestamp, body)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid_json") from None

    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge", "")}

    event = payload.get("event") or {}
    etype = event.get("type")
    if etype not in ("message", "app_mention"):
        return {"ok": True}

    text = event.get("text") or ""
    slack_user = str(event.get("user") or "")
    channel = str(event.get("channel") or "")
    if not slack_user or not channel:
        return {"ok": True}

    if text.startswith("/start "):
        await _pair(session, text.split(maxsplit=1)[1].strip(), slack_user, channel)
        return {"ok": True}

    res = await session.execute(select(User).where(User.slack_user_id == slack_user))
    user = res.scalar_one_or_none()
    if not user:
        await send_slack_message(
            channel,
            "Сначала привяжите аккаунт: POST /v1/channels/slack/link-code, затем /start КОД боту.",
        )
        return {"ok": True}

    env = IngestionEnvelope(
        text=text or None,
        attachments=[],
        channel=Channel.slack,
        correlation_id=str(event.get("event_ts") or payload.get("event_id") or ""),
        channel_meta={"chat_id": channel},
    )
    job = IngestionJob(
        user_id=user.id,
        status=JobStatus.accepted.value,
        correlation_id=env.correlation_id,
        envelope=env.model_dump(mode="json"),
    )
    session.add(job)
    await session.flush()

    if get_settings().message_mode == "queue":
        await session.commit()
        from app.queue.runner import get_runner

        get_runner().enqueue(job.id)
        return {"ok": True}

    try:
        out = await process_envelope(session, user.id, job, env)
        await session.commit()
        reply = out.get("assistant_text") or "Готово."
        if out.get("failed"):
            reply = f"Ошибка: {out.get('error')}"
        await send_slack_message(channel, str(reply))
    except Exception as exc:  # noqa: BLE001
        await session.rollback()
        await send_slack_message(channel, f"Ошибка: {exc}")
    return {"ok": True}
