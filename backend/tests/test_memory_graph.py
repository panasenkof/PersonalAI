"""Personal memory graph, optimistic corrections, provenance and rollback regression."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import delete, event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.domains.automotive.handlers import auto_approve_schedule
from app.memory.contracts import NewCollection, NewEntity, NewObservation
from app.memory.repository import MemoryAccessError, MemoryConflictError
from app.memory.sqlalchemy import SqlAlchemyMemoryRepository
from app.models import Base, Entity, MemoryRelation, ScheduleCandidate, User


async def _db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def enable_foreign_keys(conn, _):
        cursor = conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.mark.asyncio
async def test_cross_collection_links_and_owner_boundaries():
    engine, factory = await _db()
    try:
        async with factory() as s:
            a = User(email="link-owner@sample.local", password_hash="x")
            b = User(email="link-outsider@sample.local", password_hash="x")
            s.add_all([a, b])
            await s.flush()
            owner, other = SqlAlchemyMemoryRepository(s, a.id), SqlAlchemyMemoryRepository(s, b.id)
            garage = await owner.create_collection(NewCollection(name="Garage", slug="garage"))
            docs = await owner.create_collection(NewCollection(name="Docs", slug="docs"))
            vehicle = await owner.create_entity(NewEntity(
                collection_id=garage.id, domain="automotive", payload={"model": "Camry"},
            ))
            receipt = await owner.create_entity(NewEntity(
                collection_id=docs.id, domain="documents", payload={"title": "Oil receipt"},
            ))
            secret = await other.create_collection(NewCollection(name="Private", slug="private"))
            outsider = await other.create_entity(NewEntity(
                collection_id=secret.id, domain="notes", payload={"text": "private"},
            ))
            relation = await owner.link_entities(
                source_entity_id=vehicle.id, target_entity_id=receipt.id,
                kind="has_receipt", source_kind="user", source_ref="chat:123",
            )
            assert relation.kind == "has_receipt" and relation.source_ref == "chat:123"
            assert relation.source_entity_id != relation.target_entity_id
            assert (await owner.relations_for_entity(vehicle.id)) == [relation]
            assert (await owner.relations_for_entity(receipt.id)) == [relation]
            assert await other.relations_for_entity(vehicle.id) == []
            assert await other.relations_for_entity(outsider.id) == []
            with pytest.raises(MemoryAccessError, match="entity_not_found"):
                await owner.link_entities(
                    source_entity_id=vehicle.id, target_entity_id=outsider.id, kind="related_to",
                )
            with pytest.raises(MemoryConflictError, match="relation_exists"):
                await owner.link_entities(
                    source_entity_id=vehicle.id, target_entity_id=receipt.id, kind="has_receipt",
                )
            with pytest.raises(ValueError, match="self_relation_not_allowed"):
                await owner.link_entities(
                    source_entity_id=vehicle.id, target_entity_id=vehicle.id, kind="related_to",
                )
            with pytest.raises(ValueError, match="invalid_relation_kind"):
                await owner.link_entities(
                    source_entity_id=vehicle.id, target_entity_id=receipt.id, kind="bad kind",
                )
            await s.commit()

        async with factory() as s:
            # Database FK cascades remove a relation when either endpoint is deleted.
            await s.execute(delete(Entity).where(Entity.id == receipt.id))
            await s.commit()
            assert await SqlAlchemyMemoryRepository(s, a.id).relations_for_entity(vehicle.id) == []
            assert await s.scalar(select(MemoryRelation.id).where(MemoryRelation.id == relation.id)) is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_versioned_entity_and_observation_corrections_are_optimistic_and_atomic():
    engine, factory = await _db()
    try:
        async with factory() as s:
            a = User(email="correction-owner@sample.local", password_hash="x")
            b = User(email="correction-outsider@sample.local", password_hash="x")
            s.add_all([a, b])
            await s.flush()
            repo, outsider = SqlAlchemyMemoryRepository(s, a.id), SqlAlchemyMemoryRepository(s, b.id)
            col = await repo.create_collection(NewCollection(name="Garage", slug="garage"))
            car = await repo.create_entity(NewEntity(
                collection_id=col.id, domain="automotive",
                payload={"model": "Camry", "year": 2020},
                source_kind="user", source_ref="chat:original",
            ))
            event_date = datetime(2025, 2, 4, tzinfo=timezone.utc)
            obs = await repo.create_observation(NewObservation(
                entity_id=car.id, occurred_at=event_date,
                kind="service_event", payload={"odometer_km": 100_000},
                source_kind="document", source_ref="blob:original",
            ))
            assert car.record_version == obs.record_version == 1
            assert await repo.revisions(record_type="entity", record_id=car.id) == []
            current = await repo.revise_entity(
                car.id, expected_version=1, payload={"model": "Camry", "year": 2021},
                reason="correct mistaken year",
            )
            assert current.record_version == 2 and current.payload["year"] == 2021
            assert current.source_ref == "chat:original"
            assert current.updated_at is not None
            with pytest.raises(MemoryConflictError, match="stale_memory_version"):
                await repo.revise_entity(
                    car.id, expected_version=1, payload={"year": 1999}, reason="stale client",
                )
            with pytest.raises(MemoryAccessError, match="entity_not_found"):
                await outsider.revise_entity(
                    car.id, expected_version=2, payload={}, reason="unauthorized",
                )

            changed = await repo.revise_observation(
                obs.id, expected_version=1, payload={"odometer_km": 101_000},
                reason="transcribed odometer incorrectly", actor_kind="user",
            )
            assert changed.record_version == 2
            assert changed.occurred_at == event_date
            with pytest.raises(MemoryConflictError, match="stale_memory_version"):
                await repo.revise_observation(
                    obs.id, expected_version=1, payload={}, reason="stale client",
                )
            assert await outsider.revisions(record_type="entity", record_id=car.id) == []
            assert await outsider.revisions(record_type="observation", record_id=obs.id) == []
            assert await repo.revisions(record_type="entity", record_id="absent") == []
            with pytest.raises(ValueError, match="invalid_record_type"):
                await repo.revisions(record_type="other", record_id=car.id)
            entities = await repo.revisions(record_type="entity", record_id=car.id)
            observations = await repo.revisions(record_type="observation", record_id=obs.id)
            assert len(entities) == len(observations) == 1
            assert entities[0].version == 2 and entities[0].before_state["payload"]["year"] == 2020
            assert entities[0].after_state["payload"]["year"] == 2021
            assert entities[0].reason == "correct mistaken year"
            assert observations[0].before_state["payload"]["odometer_km"] == 100_000
            assert observations[0].after_state["payload"]["odometer_km"] == 101_000
            assert observations[0].before_state["occurred_at"] == event_date.isoformat()
            # Returned historical snapshots are detached from the ORM JSON fields.
            entities[0].before_state["payload"]["year"] = -1
            assert (await repo.revisions(record_type="entity", record_id=car.id))[0].before_state["payload"]["year"] == 2020
            await s.commit()

        async with factory() as s:
            repo = SqlAlchemyMemoryRepository(s, a.id)
            assert (await repo.entity(car.id)).payload["year"] == 2021
            assert (await repo.observation(obs.id)).payload["odometer_km"] == 101_000
            assert len(await repo.revisions(record_type="entity", record_id=car.id)) == 1
            new = await repo.revise_entity(
                car.id, expected_version=2, payload={"model": "Camry", "year": 2022},
                reason="correction to correction", record_status="superseded",
            )
            assert new.record_status == "superseded" and new.record_version == 3
            assert [r.version for r in await repo.revisions(record_type="entity", record_id=car.id)] == [2, 3]
            await s.rollback()

        async with factory() as s:
            repo = SqlAlchemyMemoryRepository(s, a.id)
            assert (await repo.entity(car.id)).record_version == 2
            assert len(await repo.revisions(record_type="entity", record_id=car.id)) == 1
            with pytest.raises(ValueError, match="invalid_reason"):
                await repo.revise_entity(car.id, expected_version=2, payload={}, reason=" ")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_vehicle_approval_creates_only_one_versioned_revision(monkeypatch):
    engine, factory = await _db()

    async def without_embedding(*_args, **_kwargs):
        return 0

    monkeypatch.setattr("app.rag.indexing.reindex_entity", without_embedding)
    try:
        async with factory() as s:
            person = User(email="vehicle-revision@sample.local", password_hash="x")
            s.add(person)
            await s.flush()
            repo = SqlAlchemyMemoryRepository(s, person.id)
            garage = await repo.create_collection(NewCollection(name="Garage", slug="garage"))
            car = await repo.create_entity(NewEntity(
                collection_id=garage.id, domain="automotive",
                payload={"type": "vehicle", "model": "Camry"},
            ))
            candidate = ScheduleCandidate(
                user_id=person.id, vehicle_entity_id=car.id,
                source_url="https://example.org/schedule", structured={"items": [{"name": "Oil", "interval_km": 10000}]},
            )
            s.add(candidate)
            await s.flush()
            result = await auto_approve_schedule(s, person.id, {"schedule_candidate_id": candidate.id})
            assert result["status"] == "approved"
            car_after = await repo.entity(car.id)
            assert car_after is not None and car_after.record_version == 2
            assert car_after.payload["schedule_candidate_id"] == candidate.id
            history = await repo.revisions(record_type="entity", record_id=car.id)
            assert len(history) == 1 and history[0].actor_kind == "tool"
            assert history[0].before_state["payload"] == {"type": "vehicle", "model": "Camry"}
            assert (await auto_approve_schedule(s, person.id, {"schedule_candidate_id": candidate.id}))["status"] == "approved"
            assert len(await repo.revisions(record_type="entity", record_id=car.id)) == 1
            await s.commit()
    finally:
        await engine.dispose()
