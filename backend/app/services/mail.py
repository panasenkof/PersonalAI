"""Durable mail delivery. No tokens or recipient addresses are logged."""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from datetime import timedelta
from email.message import EmailMessage

from sqlalchemy import delete, select, update

from app.config import get_settings
from app.db import SessionLocal
from app.models import EmailAction, MailOutbox, utcnow

logger = logging.getLogger(__name__)


def mail_configured() -> bool:
    s = get_settings()
    return bool(s.smtp_host and s.smtp_from and s.public_base_url)


def send_mail(recipient: str, subject: str, body: str) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg['From'], msg['To'], msg['Subject'] = s.smtp_from, recipient, subject
    msg.set_content(body)
    connection = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=20, context=ssl.create_default_context()) if s.smtp_ssl else smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
    with connection as smtp:
        if s.smtp_starttls and not s.smtp_ssl:
            smtp.starttls(context=ssl.create_default_context())
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password)
        smtp.send_message(msg)


async def deliver_pending() -> int:
    now = utcnow()
    delivered = 0
    async with SessionLocal() as session:
        await session.execute(delete(EmailAction).where(EmailAction.expires_at <= now))
        await session.execute(delete(MailOutbox).where(MailOutbox.expires_at <= now))
        await session.commit()
        rows = list((await session.scalars(select(MailOutbox).where(MailOutbox.available_at <= now).limit(10))).all())
        for row in rows:
            available = now + timedelta(seconds=60)
            claimed = await session.execute(update(MailOutbox).where(MailOutbox.id == row.id, MailOutbox.available_at <= now).values(available_at=available, attempts=MailOutbox.attempts + 1).execution_options(synchronize_session=False))
            await session.commit()
            if claimed.rowcount != 1:  # type: ignore[attr-defined]
                continue
            try:
                await asyncio.to_thread(send_mail, row.recipient, row.subject, row.body)
            except Exception:  # noqa: BLE001
                logger.warning('mail delivery failed; durable retry scheduled')
                continue
            await session.execute(delete(MailOutbox).where(MailOutbox.id == row.id))
            await session.commit()
            delivered += 1
    return delivered


async def maintenance_loop(stop: asyncio.Event) -> None:
    from app.services.account import cleanup_deleted_blobs

    while not stop.is_set():
        try:
            if mail_configured():
                await deliver_pending()
            await cleanup_deleted_blobs()
        except Exception:  # noqa: BLE001
            logger.warning('account maintenance failed; will retry')
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except TimeoutError:
            pass
