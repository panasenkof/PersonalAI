from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base, Collection, Entity, ReminderNotification, User
from app.scheduler.reminders import select_due_items


def test_select_due_items_threshold() -> None:
    due = {
        "items": [
            {"item": "Масло", "km_until_due": 300},
            {"item": "Тормоза", "km_until_due": 500},
            {"item": "Фильтр", "km_until_due": 1200},
            {"item": "Ремень", "km_until_due": -50},
        ]
    }
    picked = select_due_items(due, threshold_km=500)
    names = [i["item"] for i in picked]
    assert names == ["Масло", "Тормоза", "Ремень"]  # overdue included, far items excluded


def test_reminder_dedupe_unique_day() -> None:
    """DB constraint guarantees one notification per (user, entity, item, day)."""

    async def main():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        S = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with S() as s:
            u = User(email="r@t.dev", password_hash="x")
            s.add(u)
            await s.flush()
            c = Collection(user_id=u.id, name="Garage", slug="garage")
            s.add(c)
            await s.flush()
            e = Entity(
                user_id=u.id,
                collection_id=c.id,
                domain="automotive",
                payload={"type": "vehicle", "make": "Toyota", "model": "Camry"},
            )
            s.add(e)
            await s.flush()
            s.add(
                ReminderNotification(
                    user_id=u.id, entity_id=e.id, item="Масло", sent_on="2026-09-29"
                )
            )
            await s.commit()  # keep fixtures alive across the rollback below
            # same day, same item → violates unique constraint
            s.add(
                ReminderNotification(
                    user_id=u.id, entity_id=e.id, item="Масло", sent_on="2026-09-29"
                )
            )
            with pytest.raises(Exception) as excinfo:
                await s.flush()
            assert "UNIQUE" in str(excinfo.value).upper()
            await s.rollback()

        # different day → allowed
        async with S() as s:
            res = await s.execute(select(User))
            u = res.scalar_one()
            res = await s.execute(select(Entity).where(Entity.user_id == u.id))
            e = res.scalar_one()
            s.add(
                ReminderNotification(
                    user_id=u.id, entity_id=e.id, item="Масло", sent_on="2026-09-30"
                )
            )
            await s.flush()

    asyncio.run(main())


@pytest.mark.parametrize("telegram", [False, True])
def test_max_reminders_and_telegram_preference(monkeypatch, telegram):
    from app.config import get_settings
    from app.scheduler import reminders
    s = get_settings()
    monkeypatch.setattr(s, "max_bot_token", "max-token")
    monkeypatch.setattr(s, "telegram_bot_token", "tg-token" if telegram else "")
    deliveries = []
    async def send_max(user_id, text):
        deliveries.append(("max", user_id))
    async def send_tg(chat_id, text):
        deliveries.append(("telegram", chat_id))
    monkeypatch.setattr("app.channels.max.send_max_message", send_max)
    monkeypatch.setattr("app.channels.telegram.send_telegram_message", send_tg)
    async def due(*args):
        return {"items": [{"item": "Масло", "km_until_due": 100}]}
    monkeypatch.setattr(reminders, "auto_compute_next_due", due)
    async def main():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        S = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(reminders, "SessionLocal", S)
        async with S() as session:
            u = User(email="max-reminder@test.dev", password_hash="x", max_user_id="123", telegram_user_id="456")
            session.add(u)
            await session.flush()
            c = Collection(
                user_id=u.id, name="Garage", slug="garage",
                sensitivity="standard", allow_messenger_reminders=True,
            )
            session.add(c)
            await session.flush()
            session.add(Entity(user_id=u.id, collection_id=c.id, domain="automotive", payload={"type": "vehicle", "approved_maintenance_schedule": True}))
            await session.commit()
        # Revocation must suppress the reminder even if a vehicle is due.
        async with S() as session:
            col = (await session.scalars(select(Collection))).one()
            col.allow_messenger_reminders = False
            await session.commit()
        assert await reminders.check_reminders_once() == 0
        async with S() as session:
            col = (await session.scalars(select(Collection))).one()
            col.allow_messenger_reminders = True
            await session.commit()
        assert await reminders.check_reminders_once() == 1
        assert await reminders.check_reminders_once() == 0
        assert deliveries == [("telegram", 456)] if telegram else deliveries == [("max", 123)]
        await engine.dispose()
    asyncio.run(main())
