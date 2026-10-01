from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.domains.automotive.handlers import auto_compute_next_due
from app.models import Base, Collection, Entity, Observation, User


async def test_compute_next_due_deterministic() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with Session() as session:
        u = User(email="x@test.dev", password_hash="x")
        session.add(u)
        await session.flush()
        col = Collection(user_id=u.id, name="Garage", slug="garage")
        session.add(col)
        await session.flush()
        veh = Entity(
            user_id=u.id,
            collection_id=col.id,
            domain="automotive",
            payload={
                "type": "vehicle",
                "make": "Test",
                "model": "Car",
                "year": 2020,
                "odometer_km": 100000,
                "approved_maintenance_schedule": {
                    "items": [{"name": "Oil", "interval_km": 10000, "interval_months": 12}],
                    "source_summary": "test",
                },
            },
        )
        session.add(veh)
        await session.flush()
        obs = Observation(
            user_id=u.id,
            entity_id=veh.id,
            occurred_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
            kind="service_event",
            payload={"type": "service_event", "odometer_km": 95000, "work_items": ["oil"]},
        )
        session.add(obs)
        await session.commit()

    async with Session() as session:
        out = await auto_compute_next_due(session, u.id, {"vehicle_entity_id": veh.id})
        await session.commit()

    assert "items" in out
    assert out["items"][0]["item"] == "Oil"
    assert out["items"][0]["next_odometer_km_target"] == 105000
