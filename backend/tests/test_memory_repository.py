"""Repository contract for the server adapter and API compatibility."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.universal_tools import kb_list_entities
from app.db import SessionLocal
from app.memory.contracts import NewCollection, NewEntity, NewObservation
from app.memory.repository import MemoryAccessError, MemoryConflictError, MemoryRepository
from app.memory.sqlalchemy import SqlAlchemyMemoryRepository
from app.models import Base, Collection, Entity, Observation, User


async def _memory_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return engine, session_factory


@pytest.mark.asyncio
async def test_memory_repository_contract_and_owner_isolation():
    engine, factory = await _memory_session()
    try:
        async with factory() as session:
            a = User(email="memory-owner@example.com", password_hash="x")
            b = User(email="memory-outsider@example.com", password_hash="x")
            session.add_all([a, b])
            await session.flush()

            owner: MemoryRepository = SqlAlchemyMemoryRepository(session, a.id)
            outsider: MemoryRepository = SqlAlchemyMemoryRepository(session, b.id)

            garage = await owner.create_collection(NewCollection(name="Garage", slug="garage", sensitivity="standard"))
            health = await owner.create_collection(NewCollection(name="Health", slug="health", sensitivity="sensitive"))
            assert [c.slug for c in await owner.list_collections()] == ["garage", "health"] or {
                c.slug for c in await owner.list_collections()
            } == {"garage", "health"}
            assert await outsider.list_collections() == []
            assert await outsider.collection_by_id(garage.id) is None
            assert await outsider.collection_by_slug("garage") is None
            with pytest.raises(MemoryConflictError, match="collection_slug_exists"):
                await owner.create_collection(NewCollection(name="Duplicate", slug="garage"))

            created = []
            for value in ("Camry", "Corolla", "RAV4"):
                entity = await owner.create_entity(NewEntity(
                    collection_id=garage.id, domain="automotive", payload={"make": "Toyota", "model": value},
                    title=value, source_kind="user", source_ref="chat:1",
                    valid_from=datetime(2025, 1, 1, tzinfo=timezone.utc),
                ))
                created.append(entity)
            med = await owner.create_entity(NewEntity(
                collection_id=health.id, domain="medical_labs",
                payload={"type": "lab_profile"}, sensitivity="inherit",
            ))
            assert len((await owner.entities(domain="automotive")).items) == 3
            page1 = await owner.entities(collection_id=garage.id, limit=2)
            assert len(page1.items) == 2 and page1.next_offset == 2
            page2 = await owner.entities(collection_id=garage.id, limit=2, offset=2)
            assert len(page2.items) == 1 and page2.next_offset is None
            assert {e.id for e in (*page1.items, *page2.items)} == {e.id for e in created}
            assert len((await owner.entities(domain="medical_labs")).items) == 1
            assert await owner.entity(med.id) == med
            assert await outsider.entity(created[0].id) is None
            assert (await outsider.entities()).items == ()
            with pytest.raises(MemoryAccessError, match="collection_not_found"):
                await outsider.create_entity(NewEntity(
                    collection_id=garage.id, domain="automotive", payload={"leak": True},
                ))
            for invalid in ((0, 0), (101, 0), (1, -1)):
                with pytest.raises(ValueError, match="invalid_pagination"):
                    await owner.entities(limit=invalid[0], offset=invalid[1])

            observed = await owner.create_observation(NewObservation(
                entity_id=created[0].id, kind="service_event",
                occurred_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
                payload={"work_items": ["oil"]}, confidence=0.9,
                source_kind="document", source_ref="blob:receipt",
            ))
            assert observed.confidence == 0.9
            assert observed.source_kind == "document"
            assert await owner.observation(observed.id) == observed
            assert (await owner.observations(entity_id=created[0].id)).items == (observed,)
            assert (await owner.observations(kind="service_event")).items == (observed,)
            assert await outsider.observation(observed.id) is None
            assert (await outsider.observations(entity_id=created[0].id)).items == ()
            with pytest.raises(MemoryAccessError, match="entity_not_found"):
                await outsider.create_observation(NewObservation(
                    entity_id=created[0].id, occurred_at=observed.occurred_at,
                    kind="service_event", payload={"leak": True},
                ))
            with pytest.raises(ValueError, match="invalid_confidence"):
                await owner.create_observation(NewObservation(
                    entity_id=med.id, occurred_at=observed.occurred_at,
                    kind="lab_report", payload={}, confidence=1.5,
                ))
            await session.commit()

        async with factory() as session:
            owner = SqlAlchemyMemoryRepository(session, a.id)
            assert (await owner.entity(created[0].id)).title == "Camry"
            assert (await owner.entity(created[0].id)).source_ref == "chat:1"
            assert (await owner.observation(observed.id)).source_ref == "blob:receipt"
            assert len((await owner.list_collections())) == 2
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_repository_returns_detached_payload_and_never_commits():
    engine, factory = await _memory_session()
    try:
        async with factory() as session:
            person = User(email="rollback-owner@example.com", password_hash="x")
            session.add(person)
            await session.commit()
            owner_id = person.id
        async with factory() as session:
            repo: MemoryRepository = SqlAlchemyMemoryRepository(session, owner_id)
            col = await repo.create_collection(NewCollection(name="Private", slug="private"))
            data = {"nested": {"password": "original"}}
            entity = await repo.create_entity(NewEntity(
                collection_id=col.id, domain="notes", payload=data,
            ))
            data["nested"]["password"] = "changed"
            entity.payload["nested"]["password"] = "also changed"
            loaded = await repo.entity(entity.id)
            assert loaded is not None and loaded.payload["nested"]["password"] == "original"
            assert (await session.get(Entity, entity.id)).payload["nested"]["password"] == "original"
            await session.rollback()
        async with factory() as session:
            repo = SqlAlchemyMemoryRepository(session, owner_id)
            assert await repo.collection_by_slug("private") is None
            assert await repo.entity(entity.id) is None
            assert (await session.execute(select(Observation))).scalars().first() is None
    finally:
        await engine.dispose()


def test_legacy_collections_api_and_agent_tools(client, random_email):
    response = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    assert response.status_code == 200
    headers = {"Authorization": f"Bearer {response.json()['access_token']}"}
    collections = client.get("/v1/collections", headers=headers)
    assert collections.status_code == 200
    assert {"name": "Garage", "slug": "garage"} <= {
        "name": next(c["name"] for c in collections.json() if c["slug"] == "garage"), "slug": "garage"
    }
    assert all(set(c) == {"id", "name", "slug"} for c in collections.json())

    async def seed():
        async with SessionLocal() as session:
            owner = (await session.execute(select(User).where(User.email == random_email))).scalar_one()
            repo = SqlAlchemyMemoryRepository(session, owner.id)
            garage = await repo.collection_by_slug("garage")
            assert garage
            await repo.create_entity(NewEntity(
                collection_id=garage.id, domain="automotive", payload={"type": "vehicle", "model": "Camry"},
            ))
            result = await kb_list_entities(session, owner.id, {"domain": "automotive"})
            await session.commit()
            return result

    tool = asyncio.run(seed())
    assert tool["entities"] and tool["entities"][0]["payload"]["model"] == "Camry"
    by_collection = client.get("/v1/collections/garage/entities", headers=headers)
    assert by_collection.status_code == 200
    assert by_collection.json()[0]["payload"]["model"] == "Camry"
    assert set(by_collection.json()[0]) == {"id", "domain", "payload"}
    assert client.get("/v1/collections/nonexistent/entities", headers=headers).json() == []
