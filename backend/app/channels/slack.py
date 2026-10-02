from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
from typing import Any
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.channels.common import (
    RATE_LIMITED_TEXT,
    DuplicateDelivery,
    apply_fact_action,
    cancel_latest_job,
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

router = APIRouter(prefix="/v1/channels/slack", tags=["slack"])

SIGNATURE_MAX_AGE_SECONDS = 60 * 5
SLACK_TEXT_LIMIT = 3900
_MENTION = re.compile(r"<@[A-Z0-9]+>\s*")


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
    if not require_webhook_secret(secret, "slack"):
        return  # dev mode: disabled until SLACK_SIGNING_SECRET is configured
    if not verify_slack_signature(timestamp, sig, body, secret):
        raise HTTPException(status_code=401, detail="invalid_slack_signature")


async def send_slack_message(
    channel: str,
    text: str,
    thread_ts: str | None = None,
    blocks: list[dict[str, Any]] | None = None,
) -> None:
    token = get_settings().slack_bot_token
    if not token:
        raise RuntimeError("slack_bot_token_not_configured")
    payload: dict[str, Any] = {"channel": channel, "text": text[:SLACK_TEXT_LIMIT]}
    if thread_ts:
        payload["thread_ts"] = thread_ts
    if blocks:
        payload["blocks"] = blocks
    response = await request_json(
        "POST",
        "https://slack.com/api/chat.postMessage",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        label="slack/postMessage",
    )

    if response.json().get("ok") is not True:
        raise RuntimeError("slack_message_rejected")


def _chunks(text: str, limit: int = SLACK_TEXT_LIMIT) -> list[str]:
    return [text[i : i + limit] for i in range(0, len(text), limit)] or [""]


def _fact_blocks(fact: dict[str, Any]) -> list[dict[str, Any]]:
    summary = str(fact.get("summary") or fact.get("kind") or "")[:2500]
    return [
        {"type": "section", "text": {"type": "mrkdwn", "text": f":memo: Проверьте распознанные данные:\n{summary}"}},
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "✅ Подтвердить"},
                    "style": "primary",
                    "action_id": "fact_confirm",
                    "value": fact["id"],
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "❌ Отклонить"},
                    "style": "danger",
                    "action_id": "fact_reject",
                    "value": fact["id"],
                },
            ],
        },
    ]


async def reply(env: IngestionEnvelope, text: str, facts: list[dict[str, Any]]) -> None:
    meta = env.channel_meta or {}
    channel = meta.get("chat_id")
    if not channel:
        return
    thread_ts = meta.get("reply_thread_ts")
    for part in _chunks(str(text)):
        if thread_ts:
            await send_slack_message(str(channel), part, thread_ts=thread_ts)
        else:
            await send_slack_message(str(channel), part)
    for fact in facts:
        await send_slack_message(
            str(channel),
            f"Проверьте распознанные данные: {fact.get('summary')}",
            thread_ts=thread_ts,
            blocks=_fact_blocks(fact),
        )


@router.post("/link-code")
async def create_link_code(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Same link-code flow as Telegram: POST with JWT, then /start CODE in Slack."""
    code, exp = await issue_link_code(session, user)
    return {
        "code": code,
        "expires_at": exp.isoformat(),
        "instructions": "Send /start CODE to the Slack bot in a DM.",
    }


async def _download_slack_file(file: dict[str, Any]) -> bytes:
    token = get_settings().slack_bot_token
    url = file.get("url_private_download") or file.get("url_private")
    if not token or not url:
        raise HTTPException(500, detail="slack file download not configured")
    r = await request_json(
        "GET", url, headers={"Authorization": f"Bearer {token}"}, timeout=60.0, label="slack/file"
    )
    return r.content


async def _collect_files(session: AsyncSession, user: User, event: dict[str, Any]) -> list[Attachment]:
    limit = getattr(get_settings(), "max_upload_bytes", 20 * 1024 * 1024)
    out: list[Attachment] = []
    for f in (event.get("files") or [])[:5]:
        if int(f.get("size") or 0) > limit:
            continue
        try:
            data = await _download_slack_file(f)
        except Exception as exc:  # noqa: BLE001 — one bad file must not drop the message
            logger.warning("slack file download failed: %s", exc)
            continue
        if len(data) > limit:
            continue
        mime = f.get("mimetype") or "application/octet-stream"
        name = f.get("name") or "slack_file"
        blob = await store_blob(session, user.id, data, mime, filename=name)
        out.append(Attachment(mime=mime, storage_key=blob.storage_key, filename=name))
    return out


def _thread_context(event: dict[str, Any], channel: str) -> tuple[str, str | None]:
    """(conversation external_ref, thread_ts to answer in or None for a flat DM)."""
    thread_ts = event.get("thread_ts")
    is_dm = event.get("channel_type") == "im" or channel.startswith("D")
    if thread_ts:
        return f"slack:{channel}:{thread_ts}", str(thread_ts)
    if is_dm:
        return f"slack:{channel}", None
    root = str(event.get("ts") or event.get("event_ts") or "")
    return f"slack:{channel}:{root}", root or None


@router.post("/events")
async def slack_events(
    request: Request,
    x_slack_signature: str | None = Header(None, alias="X-Slack-Signature"),
    x_slack_request_timestamp: str | None = Header(None, alias="X-Slack-Request-Timestamp"),
    x_slack_retry_num: str | None = Header(None, alias="X-Slack-Retry-Num"),
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
    # Retries must reach the durable dedupe check; the first delivery may have crashed.

    event = payload.get("event") or {}
    etype = event.get("type")
    if etype not in ("message", "app_mention"):
        return {"ok": True}
    subtype = event.get("subtype")
    if event.get("bot_id") or (subtype and subtype != "file_share"):
        return {"ok": True}  # our own replies, edits, joins... never answer bots (loop protection)

    text = _MENTION.sub("", event.get("text") or "").strip()
    slack_user = str(event.get("user") or "")
    channel = str(event.get("channel") or "")
    if not slack_user or not channel:
        return {"ok": True}

    if text.startswith("/start "):
        code = text.split(maxsplit=1)[1].strip()
        if await pair_account(session, code, "slack_user_id", slack_user):
            await send_slack_message(channel, "Аккаунт привязан ✔ Можно писать сообщения.")
        else:
            await send_slack_message(channel, "Код недействителен или истёк.")
        return {"ok": True}

    user = await user_by_channel_id(session, "slack_user_id", slack_user)
    if not user:
        await send_slack_message(
            channel,
            "Сначала привяжите аккаунт: POST /v1/channels/slack/link-code, затем /start КОД боту.",
        )
        return {"ok": True}

    external_ref, reply_thread = _thread_context(event, channel)
    command = text.split(maxsplit=1)[0].lower() if text.startswith("/") else ""
    if command == "/stop":
        stopped = await cancel_latest_job(session, user.id)
        await send_slack_message(channel, "Остановлено." if stopped else "Нет активных задач.")
        return {"ok": True}
    if command == "/new":
        await start_new_conversation(session, user.id, "slack", external_ref)
        await send_slack_message(channel, "Начат новый диалог.")
        return {"ok": True}

    attachments = await _collect_files(session, user, event) if event.get("files") else []
    # `ts` is identical for the `message` and `app_mention` events of one post → deduped together
    msg_ts = event.get("ts") or event.get("client_msg_id") or payload.get("event_id")
    env = IngestionEnvelope(
        text=text or None,
        attachments=attachments,
        channel=Channel.slack,
        correlation_id=f"slack:{channel}:{msg_ts}" if msg_ts else None,
        external_ref=external_ref,
        channel_meta={"chat_id": channel, "reply_thread_ts": reply_thread},
    )
    try:
        out = await submit_envelope(session, user, env)
        if out is not None:
            from app.queue.delivery import deliver_reply

            await deliver_reply(out["_delivery_job_id"])
    except DuplicateDelivery:
        await session.rollback()
    except RateLimitExceeded:
        await session.rollback()
        await send_slack_message(channel, RATE_LIMITED_TEXT)
    except Exception as exc:  # noqa: BLE001
        await session.rollback()
        await send_slack_message(channel, f"Ошибка: {safe_error(exc)}")
    return {"ok": True}


@router.post("/interactive")
async def slack_interactive(
    request: Request,
    x_slack_signature: str | None = Header(None, alias="X-Slack-Signature"),
    x_slack_request_timestamp: str | None = Header(None, alias="X-Slack-Request-Timestamp"),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Block Kit button presses (confirm / reject an extracted fact). Content-Type: form-urlencoded."""
    body = await request.body()
    _verify(x_slack_signature, x_slack_request_timestamp, body)
    try:
        payload = json.loads(parse_qs(body.decode()).get("payload", ["{}"])[0])
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid_payload") from None
    actions = payload.get("actions") or []
    slack_user = str((payload.get("user") or {}).get("id") or "")
    user = await user_by_channel_id(session, "slack_user_id", slack_user) if slack_user else None
    if not actions or user is None:
        return {"ok": True}
    act = actions[0]
    cb = {"fact_confirm": "c", "fact_reject": "r"}.get(str(act.get("action_id")))
    parsed = parse_fact_callback(f"fact:{cb}:{act.get('value')}") if cb else None
    if parsed is None:
        return {"ok": True}
    result_text = await apply_fact_action(session, user, parsed[0], parsed[1])
    url = payload.get("response_url")
    if url:
        try:
            await request_json(
                "POST", url, json={"replace_original": True, "text": result_text}, label="slack/response_url"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("slack response_url failed: %s", exc)
    return {"ok": True}
