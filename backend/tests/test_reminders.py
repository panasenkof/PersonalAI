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
