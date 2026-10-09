"""Additive memory v2 metadata: legacy writes and user-visible payloads still work."""
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Collection, Entity, Observation
from app.services.users import bootstrap_user


@pytest.mark.asyncio
async def test_existing_entity_and_observation_write_contract():
    async with SessionLocal() as session:
        user = await bootstrap_user(session, "memory-v2@example.com", "unused")
        garage = await session.scalar(
            select(Collection).where(Collection.user_id == user.id, Collection.slug == "garage")
        )
        health = await session.scalar(
            select(Collection).where(Collection.user_id == user.id, Collection.slug == "health")
        )
        assert garage and health
        assert garage.sensitivity == "standard"
        assert health.sensitivity == "sensitive"

        # The previous constructors and JSON payload contract still work.
        entity = Entity(
            user_id=user.id, collection_id=garage.id, domain="automotive",
            payload={"type": "vehicle", "make": "Toyota"},
        )
        session.add(entity)
        await session.flush()
        observation = Observation(
            user_id=user.id, entity_id=entity.id,
            occurred_at=datetime(2026, 9, 15, tzinfo=timezone.utc),
            kind="service_event", payload={"notes": "battery replacement"},
        )
        session.add(observation)
        await session.commit()
        await session.refresh(entity)
        await session.refresh(observation)
        assert entity.payload == {"type": "vehicle", "make": "Toyota"}
        assert entity.record_status == "active"
        assert entity.sensitivity == "inherit"
        assert entity.valid_from is None and entity.source_ref is None
        assert observation.payload == {"notes": "battery replacement"}
        assert observation.sensitivity == "inherit"
        assert observation.confidence is None and observation.source_kind is None


@pytest.mark.asyncio
async def test_optional_provenance_validity_and_sensitivity_roundtrip():
    async with SessionLocal() as session:
        user = await bootstrap_user(session, "memory-v2-metadata@example.com", "unused")
        garage = await session.scalar(
            select(Collection).where(Collection.user_id == user.id, Collection.slug == "garage")
        )
        assert garage
        entity = Entity(
            user_id=user.id, collection_id=garage.id, domain="automotive",
            payload={"type": "vehicle"}, title="My car",
            sensitivity="sensitive", source_kind="user", source_ref="conversation:abc",
            valid_from=datetime(2025, 1, 1, tzinfo=timezone.utc),
        )
        session.add(entity)
        await session.flush()
        observation = Observation(
            user_id=user.id, entity_id=entity.id, kind="service_event",
            occurred_at=datetime(2026, 9, 15, tzinfo=timezone.utc),
            payload={"work_items": ["oil"]}, confidence=0.95,
            source_kind="document", source_ref="blob:receipt",
        )
        session.add(observation)
        await session.commit()
        await session.refresh(entity)
        await session.refresh(observation)
        assert entity.title == "My car" and entity.sensitivity == "sensitive"
        assert entity.source_kind == "user" and entity.valid_from.year == 2025
        assert observation.source_kind == "document"
        assert observation.source_ref == "blob:receipt"
        assert observation.confidence == pytest.approx(0.95)
