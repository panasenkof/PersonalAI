from __future__ import annotations

import asyncio
import logging
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.db import SessionLocal
from app.domains.automotive.handlers import auto_compute_next_due
from app.models import Collection, Entity, ReminderNotification, User

logger = logging.getLogger(__name__)


def select_due_items(
    due_result: dict,
    threshold_km: int,
) -> list[dict]:
    """Items at/below the km threshold (negative = already overdue)."""
    return [it for it in due_result.get("items", []) if int(it.get("km_until_due", 0)) <= threshold_km]


async def check_reminders_once() -> int:
    """Scan users' vehicles for due maintenance; send one messenger reminder per item per day."""
    settings = get_settings()
    if not (settings.telegram_bot_token or settings.max_bot_token):
        return 0
    sent = 0
    today = date.today().isoformat()
    async with SessionLocal() as session:
        res = await session.execute(select(User).where(User.is_active.is_(True)).where(or_(User.telegram_user_id.is_not(None), User.max_user_id.is_not(None))))
        users = list(res.scalars().all())
        for user in users:
            use_telegram = bool(settings.telegram_bot_token and user.telegram_user_id)
            if not use_telegram and not (settings.max_bot_token and user.max_user_id):
                continue
            res_v = await session.execute(
                select(Entity)
                .where(Entity.user_id == user.id)
                .where(Entity.domain == "automotive")
                .where(Entity.sensitivity.in_(("inherit", "standard")))
                .join(Collection, Collection.id == Entity.collection_id)
                .where(
                    Collection.user_id == user.id,
                    Collection.sensitivity.in_(("standard", "sensitive")),
                    Collection.allow_messenger_reminders.is_(True),
                )
            )
            for veh in res_v.scalars().all():
                if (veh.payload or {}).get("type") != "vehicle":
                    continue
                if not (veh.payload or {}).get("approved_maintenance_schedule"):
                    continue
                due = await auto_compute_next_due(
                    session, user.id, {"vehicle_entity_id": veh.id}
                )
                for item in select_due_items(due, settings.reminder_km_threshold):
                    name = str(item.get("item") or "")
                    if not name:
                        continue
                    exists = await session.execute(
                        select(ReminderNotification.id)
                        .where(ReminderNotification.user_id == user.id)
                        .where(ReminderNotification.entity_id == veh.id)
                        .where(ReminderNotification.item == name)
                        .where(ReminderNotification.sent_on == today)
                    )
                    if exists.scalar_one_or_none() is not None:
                        continue
                    # Claim first (unique constraint), send second: with several API replicas only one
                    # of them wins the row and therefore sends the message.
                    claim = ReminderNotification(user_id=user.id, entity_id=veh.id, item=name, sent_on=today)
                    session.add(claim)
                    try:
                        await session.commit()
                    except IntegrityError:
                        await session.rollback()
                        continue
                    km = int(item.get("km_until_due", 0))
                    car = f"{veh.payload.get('make', '')} {veh.payload.get('model', '')}".strip()
                    when = "просрочено" if km < 0 else f"через {km} км"
                    text = f"🔧 Напоминание ({car}): {name} — {when}."
                    from app.channels.telegram import send_telegram_message

                    try:
                        if use_telegram:
                            await send_telegram_message(chat_id=int(user.telegram_user_id or "0"), text=text)
                        else:
                            from app.channels.max import send_max_message

                            await send_max_message(user_id=int(user.max_user_id or "0"), text=text)
                    except Exception:  # noqa: BLE001 — release the claim so the next cycle retries
                        logger.warning("reminder delivery failed for user=%s item=%s", user.id, name, exc_info=True)
                        await session.delete(claim)
                        await session.commit()
                        continue
                    sent += 1
            await session.commit()
    return sent


async def reminders_loop(stop: asyncio.Event) -> None:
    settings = get_settings()
    logger.info("reminders scheduler started (every %ss)", settings.reminder_check_seconds)
    while not stop.is_set():
        try:
            await check_reminders_once()
        except Exception:  # noqa: BLE001 — scheduler must never die
            logger.exception("reminder check failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.reminder_check_seconds)
        except TimeoutError:
            continue
    logger.info("reminders scheduler stopped")
