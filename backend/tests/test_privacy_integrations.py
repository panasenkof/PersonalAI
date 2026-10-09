"""Egress permission regressions: cloud media, STT, MCP and vector revocation."""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.domains.automotive.handlers import auto_fetch_maintenance_schedule, auto_parse_service_receipt
from app.domains.medical_labs.handlers import labs_record_report
from app.ingestion.pipeline import build_user_prompt
from app.ingestion.schemas import Attachment, IngestionEnvelope
from app.ingestion.stt import WhisperApiSTTProvider
from app.llm.providers import CloudLLMProvider
from app.memory.privacy import remote_extraction_allowed
from app.models import Base, Chunk, Collection, Entity, User


class SpyCloud(CloudLLMProvider):
    def __init__(self):
        self.base_url = "https://external.example/v1"
        self.text_calls = 0
        self.vision_calls = 0

    async def text_json_schema(self, **_kwargs):
        self.text_calls += 1
        return {"panel_name": "Panel", "analytes": [{"name": "Glucose", "value": "5.0"}]}

    async def vision_json(self, **_kwargs):
        self.vision_calls += 1
        return {"vendor": "Garage", "work_items": []}


@pytest.mark.asyncio
async def test_cloud_media_and_search_deny_until_collection_grant(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    provider = SpyCloud()

    async def fake_provider(*_args):
        return provider

    async def fake_model(*_args):
        return "test-model"

    monkeypatch.setattr("app.domains.automotive.handlers.provider_for_user", fake_provider)
    monkeypatch.setattr("app.domains.automotive.handlers.default_model_for_user", fake_model)
    monkeypatch.setattr("app.domains.medical_labs.handlers.provider_for_user", fake_provider)
    monkeypatch.setattr("app.domains.medical_labs.handlers.default_model_for_user", fake_model)

    async def owned_blob(*_args):
        return True

    async def forbidden_blob(*_args):
        raise AssertionError("Raw bytes were read without cloud extraction consent")

    monkeypatch.setattr("app.services.blobs.user_owns_blob", owned_blob)
    monkeypatch.setattr("app.storage.blob.read_bytes", forbidden_blob)
    try:
        async with factory() as session:
            owner = User(email="media-owner@example.net", password_hash="x")
            other = User(email="media-other@example.net", password_hash="x")
            session.add_all([owner, other])
            await session.flush()
            garage = Collection(user_id=owner.id, name="Garage", slug="garage", sensitivity="standard")
            health = Collection(user_id=owner.id, name="Health", slug="health", sensitivity="sensitive")
            session.add_all([garage, health])
            await session.flush()
            vehicle = Entity(
                user_id=owner.id, collection_id=garage.id, domain="automotive",
                payload={"type": "vehicle", "make": "Toyota", "model": "Camry"},
            )
            session.add(vehicle)
            await session.flush()

            denied = await labs_record_report(session, owner.id, {"text": "Glucose 5.0"})
            assert denied == {"error": "remote_extraction_not_allowed"}
            assert provider.text_calls == 0
            receipt = await auto_parse_service_receipt(
                session, owner.id, {"storage_key": "private-blob", "vehicle_entity_id": vehicle.id},
            )
            assert receipt == {"error": "remote_extraction_not_allowed"}
            assert provider.vision_calls == 0
            assert await auto_fetch_maintenance_schedule(
                session, owner.id, {"vehicle_entity_id": vehicle.id},
            ) == {"error": "external_lookup_not_allowed"}
            assert not await remote_extraction_allowed(session, other.id, "garage")

            health.allow_remote_extraction = True
            garage.allow_remote_extraction = True
            await session.flush()
            assert await remote_extraction_allowed(session, owner.id, "garage", entity=vehicle)
            allowed = await labs_record_report(session, owner.id, {"text": "Glucose 5.0"})
            assert allowed["status"] == "saved"
            assert provider.text_calls == 1

            # Even an allowed collection cannot export a specifically sensitive record.
            vehicle.sensitivity = "sensitive"
            await session.flush()
            receipt = await auto_parse_service_receipt(
                session, owner.id, {"storage_key": "private-blob", "vehicle_entity_id": vehicle.id},
            )
            assert receipt == {"error": "remote_extraction_not_allowed"}
            assert provider.vision_calls == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_remote_stt_requires_explicit_opt_in(monkeypatch):
    calls: list[str] = []

    async def fake_transcribe(self, *, storage_key: str, mime: str) -> str:
        calls.append(storage_key)
        return "private voice message"

    monkeypatch.setattr(WhisperApiSTTProvider, "transcribe", fake_transcribe)
    envelope = IngestionEnvelope(
        text="hello", attachments=[Attachment(mime="audio/ogg", storage_key="private-audio")],
    )
    provider = WhisperApiSTTProvider("https://speech.example/v1", None)
    monkeypatch.setattr("app.ingestion.pipeline.stt_provider_from_settings", lambda: provider)
    unconsented = await build_user_prompt(envelope)
    assert "external transcription disabled" in unconsented
    assert "private voice message" not in unconsented
    assert calls == []
    consented = await build_user_prompt(envelope, allow_remote_stt=True)
    assert "[audio transcript] private voice message" in consented
    assert calls == ["private-audio"]

    # Local loopback speech servers do not need third-party permission.
    provider.base_url = "http://127.0.0.1:9000/v1"
    local = await build_user_prompt(envelope)
    assert "[audio transcript] private voice message" in local
    assert len(calls) == 2


def test_privacy_api_revocation_clears_vectors_and_enforces_owner(client, random_email):
    one = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    two = client.post("/v1/auth/register", json={
        "email": "other-" + random_email, "password": "secret1234",
    })
    assert one.status_code == two.status_code == 200
    h1 = {"Authorization": f"Bearer {one.json()['access_token']}"}
    h2 = {"Authorization": f"Bearer {two.json()['access_token']}"}
    assert client.get("/v1/privacy/integrations", headers=h1).json() == {
        "allow_remote_stt": False, "allow_mcp_access": False,
    }
    assert all(not c["allow_remote_extraction"] and not c["allow_messenger_reminders"]
               for c in client.get("/v1/privacy/collections", headers=h1).json())
    assert client.get("/v1/privacy/integrations").status_code == 401
    assert client.put("/v1/privacy/collections/garage", headers=h1, json={
        "sensitivity": "secret", "allow_remote_extraction": True,
    }).status_code == 422

    grant = {
        "sensitivity": "standard", "allow_cloud_llm": True,
        "allow_remote_embeddings": True, "allow_remote_extraction": True,
        "allow_messenger_reminders": True,
    }
    assert client.put("/v1/privacy/collections/garage", headers=h1, json=grant).status_code == 200
    assert client.put("/v1/privacy/integrations", headers=h1, json={
        "allow_remote_stt": True, "allow_mcp_access": True,
    }).status_code == 200
    assert client.get("/v1/privacy/integrations", headers=h2).json() == {
        "allow_remote_stt": False, "allow_mcp_access": False,
    }

    async def seed():
        from app.db import SessionLocal
        from app.models import User

        async with SessionLocal() as session:
            u = (await session.scalars(select(User).where(User.email == random_email))).one()
            other = (await session.scalars(select(User).where(
                User.email == "other-" + random_email,
            ))).one()
            garage = (await session.scalars(select(Collection).where(
                Collection.user_id == u.id, Collection.slug == "garage",
            ))).one()
            other_garage = (await session.scalars(select(Collection).where(
                Collection.user_id == other.id, Collection.slug == "garage",
            ))).one()
            rows = [
                Entity(user_id=u.id, collection_id=garage.id, domain="notes", payload={"value": "one"}),
                Entity(user_id=other.id, collection_id=other_garage.id, domain="notes", payload={"value": "two"}),
            ]
            session.add_all(rows)
            await session.flush()
            session.add_all([
                Chunk(
                    user_id=item.user_id, entity_id=item.id, text="indexed",
                    embedding=[0.25, 0.75], embedding_space="test",
                ) for item in rows
            ])
            await session.commit()
            return u.id, other.id

    u1, u2 = asyncio.run(seed())
    revoke = client.put("/v1/privacy/collections/garage", headers=h1, json={
        **grant, "allow_remote_embeddings": False, "allow_cloud_llm": False,
        "allow_remote_extraction": False, "allow_messenger_reminders": False,
    })
    assert revoke.status_code == 200

    async def verify():
        from app.db import SessionLocal

        async with SessionLocal() as session:
            a = (await session.scalars(select(Chunk).where(Chunk.user_id == u1))).all()
            b = (await session.scalars(select(Chunk).where(Chunk.user_id == u2))).all()
            assert len(a) == len(b) == 1
            assert a[0].embedding is None and a[0].embedding_space is None
            assert b[0].embedding == [0.25, 0.75]
            assert a[0].text == "indexed"  # lexical search stays available

    asyncio.run(verify())
    assert client.get("/v1/privacy/collections", headers=h2).json()[0]["allow_cloud_llm"] is False
