"""Durable messenger outbox. Delivery retries never execute the agent again.

Channel APIs do not all support idempotency: a crash after sending but before recording
success can duplicate the reply. The guarantee is at-least-once, not exactly-once.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.channels.dispatch import send_reply
from app.db import SessionLocal
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.models import ChannelDelivery, IngestionJob

logger = logging.getLogger(__name__)
MESSENGERS = {"max", "telegram", "slack", "whatsapp", "discord"}


def stage_reply(session: AsyncSession, job: IngestionJob) -> None:
    if (job.envelope or {}).get("channel") in MESSENGERS:
        session.add(ChannelDelivery(job_id=job.id, user_id=job.user_id))


async def deliver_reply(job_id: str) -> bool:
    """Compare-and-set claim with an expiring lease; independent API/worker processes are safe."""
    now = utcnow()
    token = uuid.uuid4().hex
    async with SessionLocal() as session:
        claimed = await session.execute(
            update(ChannelDelivery)
            .where(ChannelDelivery.job_id == job_id, ChannelDelivery.sent_at.is_(None),
                   ChannelDelivery.available_at <= now,
                   or_(ChannelDelivery.lease_until.is_(None), ChannelDelivery.lease_until <= now))
            .values(lease_token=token, lease_until=now + timedelta(seconds=300),
                    attempts=ChannelDelivery.attempts + 1)
        )
        await session.commit()
        if claimed.rowcount != 1:  # type: ignore[attr-defined]
            return False
        row = await session.scalar(select(ChannelDelivery).where(ChannelDelivery.job_id == job_id))
        job = await session.get(IngestionJob, job_id)
        if row is None or job is None:
            return False
        attempts = row.attempts
        env = IngestionEnvelope(**job.envelope)
        result = job.result or {}
        text = result.get("assistant_text") or ""
        if job.error:
            text = f"Ошибка: {job.error}"
        facts = result.get("pending_facts") or []
    values: dict[str, Any] = {"lease_token": None, "lease_until": None}
    try:
        await asyncio.wait_for(send_reply(env, str(text), facts), timeout=240)
    except Exception as exc:
        values.update(error=type(exc).__name__, available_at=utcnow() + timedelta(seconds=min(3600, 2 ** min(attempts, 12))))
        logger.warning("reply delivery %s failed (attempt %d)", job_id, attempts)
    else:
        values.update(sent_at=utcnow(), error=None)
    async with SessionLocal() as session:
        await session.execute(update(ChannelDelivery).where(
            ChannelDelivery.job_id == job_id, ChannelDelivery.lease_token == token
        ).values(**values))
        await session.commit()
    return "sent_at" in values


async def deliver_pending() -> int:
    async with SessionLocal() as session:
        ids = (await session.scalars(select(ChannelDelivery.job_id).where(
            ChannelDelivery.sent_at.is_(None), ChannelDelivery.available_at <= utcnow(),
            or_(ChannelDelivery.lease_until.is_(None), ChannelDelivery.lease_until <= utcnow())
        ).order_by(ChannelDelivery.available_at).limit(25))).all()
    count = 0
    for job_id in ids:
        count += int(await deliver_reply(job_id))
    return count


async def delivery_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await deliver_pending()
        except Exception:
            logger.exception("messenger outbox sweep failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=2)
        except TimeoutError:
            pass
