"""Shared plumbing for messenger channels: link codes, job submission, commands, fact buttons."""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings as _real_get_settings
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.llm.limits import check_user_quota
from app.models import (
    SETTLED_JOB_STATUSES,
    IngestionJob,
    JobStatus,
    TelegramLinkCode,
    User,
)
from app.security.ratelimit import AsyncLimiter, build_limiter
from app.services.facts import FactError, resolve_fact

RATE_LIMITED_TEXT = "Слишком много запросов, попробуйте через минуту."
DEDUPE_WINDOW = timedelta(minutes=10)


class DuplicateDelivery(Exception):
    """The platform redelivered an update we already accepted (webhook retry)."""


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def require_webhook_secret(configured: str, channel: str) -> bool:
    """True when verification must be enforced. In production a missing secret fails closed."""
    if configured:
        return True
    if _real_get_settings().is_production:
        raise HTTPException(status_code=503, detail=f"{channel}_webhook_secret_not_configured")
    return False  # development: verification disabled until the secret is configured


# --- account linking ----------------------------------------------------------------------------


async def issue_link_code(session: AsyncSession, user: User) -> tuple[str, datetime]:
    code = secrets.token_hex(4).upper()
    exp = utcnow() + timedelta(minutes=15)
    session.add(TelegramLinkCode(user_id=user.id, code=code, expires_at=exp))
    await session.commit()
    return code, exp


PAIR_MAX_FAILURES = 5
PAIR_WINDOW_SECONDS = 15 * 60
_pair_limiter: AsyncLimiter | None = None


def _pair_guard() -> AsyncLimiter:
    global _pair_limiter
    if _pair_limiter is None:
        _pair_limiter = build_limiter("pair-fail", PAIR_MAX_FAILURES, PAIR_WINDOW_SECONDS)
    return _pair_limiter


def reset_pair_limiter() -> None:
    global _pair_limiter
    _pair_limiter = None


async def pair_account(session: AsyncSession, code: str, field: str, external_id: str) -> User | None:
    """Consume a link code and bind `external_id` to the code's user (`field` = users column).

    An external account belongs to one user: re-pairing takes it over from the previous owner.
    """
    # Link codes are short: an external account that keeps guessing gets locked out for a while.
    guard, guard_key = _pair_guard(), f"{field}:{external_id}"
    if await guard.count(guard_key) >= PAIR_MAX_FAILURES:
        return None
    user = await _pair_account(session, code, field, external_id)
    if user is None:
        await guard.allow(guard_key)  # records one failed attempt
    else:
        await guard.reset(guard_key)
    return user


async def _pair_account(session: AsyncSession, code: str, field: str, external_id: str) -> User | None:
    code = code.strip().upper()
    res = await session.execute(
        select(TelegramLinkCode).where(TelegramLinkCode.code == code).where(TelegramLinkCode.consumed_at.is_(None))
    )
    link = res.scalar_one_or_none()
    if link is None or _aware(link.expires_at) < utcnow():
        return None
    user = await session.get(User, link.user_id)
    if user is None or not user.is_active:
        return None
    column = getattr(User, field)
    prev = (await session.execute(select(User).where(column == external_id))).scalar_one_or_none()
    if prev is not None and prev.id != user.id:
        setattr(prev, field, None)
        await session.flush()  # clear UNIQUE before assigning the new owner
    setattr(user, field, external_id)
    link.consumed_at = utcnow()
    await session.commit()
    return user


async def user_by_channel_id(session: AsyncSession, field: str, external_id: str) -> User | None:
    res = await session.execute(select(User).where(getattr(User, field) == external_id))
    user = res.scalar_one_or_none()
    return user if user is not None and user.is_active else None


# --- running jobs -------------------------------------------------------------------------------


async def submit_envelope(session: AsyncSession, user: User, env: IngestionEnvelope) -> dict[str, Any] | None:
    """Create a job for `env`; queue mode → enqueue and return None (worker replies later),
    sync mode → process inline and return the agent output.

    Raises RateLimitExceeded when the user's LLM quota is used up, DuplicateDelivery on a webhook retry.
    """
    if env.correlation_id:
        dup = await session.execute(
            select(IngestionJob.id)
            .where(IngestionJob.user_id == user.id)
            .where(IngestionJob.correlation_id == env.correlation_id)
            .where(IngestionJob.created_at > utcnow() - DEDUPE_WINDOW)
            .limit(1)
        )
        if dup.scalar_one_or_none() is not None:
            raise DuplicateDelivery(env.correlation_id)
    await check_user_quota(user.id)
    job = IngestionJob(
        user_id=user.id,
        status=JobStatus.accepted.value,
        correlation_id=env.correlation_id,
        envelope=env.model_dump(mode="json"),
    )
    session.add(job)
    await session.flush()
    if _channel_settings().message_mode == "queue":
        await session.commit()
        from app.queue.runner import get_runner

        try:
            await get_runner().enqueue(job.id)
        except Exception:  # noqa: BLE001 — job is persisted; the reaper re-queues it when Redis recovers
            logging.getLogger(__name__).warning("enqueue failed for job %s; reaper will retry", job.id, exc_info=True)
        return None
    out = await process_envelope(session, user.id, job, env)
    await session.commit()
    return out


def _channel_settings():
    return _real_get_settings()


def reply_text_for(out: dict[str, Any]) -> str:
    if out.get("failed"):
        return f"Ошибка: {out.get('error')}"
    return str(out.get("assistant_text") or "Готово.")


async def cancel_latest_job(session: AsyncSession, user_id: str) -> bool:
    """`/stop` in a messenger: cancel the user's most recent unfinished job."""
    res = await session.execute(
        select(IngestionJob)
        .where(IngestionJob.user_id == user_id)
        .where(IngestionJob.status.in_([JobStatus.accepted.value, JobStatus.processing.value]))
        .order_by(IngestionJob.created_at.desc())
        .limit(1)
    )
    job = res.scalar_one_or_none()
    if job is None or job.status in SETTLED_JOB_STATUSES:
        return False
    from app.queue.jobs import request_job_cancel

    await request_job_cancel(session, job)
    return True


async def start_new_conversation(session: AsyncSession, user_id: str, channel: str, external_ref: str) -> None:
    from app.models import Conversation

    session.add(Conversation(user_id=user_id, channel=channel, external_ref=external_ref))
    await session.commit()


# --- fact confirmation buttons ---------------------------------------------------------------------

FACT_CONFIRM = "confirm"
FACT_REJECT = "reject"


def fact_callback_data(action: str, fact_id: str) -> str:
    return f"fact:{'c' if action == FACT_CONFIRM else 'r'}:{fact_id}"


def parse_fact_callback(data: str) -> tuple[str, str] | None:
    parts = (data or "").split(":")
    if len(parts) == 3 and parts[0] == "fact" and parts[1] in ("c", "r"):
        return (FACT_CONFIRM if parts[1] == "c" else FACT_REJECT), parts[2]
    return None


async def apply_fact_action(session: AsyncSession, user: User, action: str, fact_id: str) -> str:
    """Resolve a fact from a button press; returns the text that replaces the prompt."""
    try:
        out = await resolve_fact(session, user.id, fact_id, confirm=action == FACT_CONFIRM)
    except FactError as exc:
        await session.rollback()
        return {
            "fact_not_found": "Запись не найдена.",
            "already_committed": "Уже сохранено ранее.",
            "already_rejected": "Уже отклонено ранее.",
        }.get(exc.code, f"Не удалось: {exc.code}")
    await session.commit()
    summary = (out["fact"].get("summary") or "").strip()
    return (f"✅ Сохранено: {summary}" if action == FACT_CONFIRM else f"❌ Отклонено: {summary}").strip()
