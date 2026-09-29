from __future__ import annotations

import asyncio
import logging
from datetime import date

from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.domains.automotive.handlers import auto_compute_next_due
from app.models import Entity, ReminderNotification, User

logger = logging.getLogger(__name__)


def select_due_items(
    due_result: dict,
    threshold_km: int,
) -> list[dict]:
    """Items at/below the km threshold (negative = already overdue)."""
    return [it for it in due_result.get("items", []) if int(it.get("km_until_due", 0)) <= threshold_km]


async def check_reminders_once() -> int:
    """Scan users' vehicles for due maintenance; send one Telegram reminder per item per day."""
    settings = get_settings()
    if not settings.telegram_bot_token:
        return 0
    sent = 0
    today = date.today().isoformat()
    async with SessionLocal() as session:
        res = await session.execute(select(User).where(User.telegram_user_id.is_not(None)))
        users = list(res.scalars().all())
        for user in users:
            if not user.telegram_user_id:
                continue
            tg_chat_id = int(user.telegram_user_id)
            res_v = await session.execute(
                select(Entity)
                .where(Entity.user_id == user.id)
                .where(Entity.domain == "automotive")
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
                    km = int(item.get("km_until_due", 0))
                    car = f"{veh.payload.get('make', '')} {veh.payload.get('model', '')}".strip()
                    when = "просрочено" if km < 0 else f"через {km} км"
                    text = f"🔧 Напоминание ({car}): {name} — {when}."
                    from app.channels.telegram import send_telegram_message

                    await send_telegram_message(chat_id=tg_chat_id, text=text)
                    session.add(
                        ReminderNotification(
                            user_id=user.id,
                            entity_id=veh.id,
                            item=name,
                            sent_on=today,
                        )
                    )
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
