"""Regression coverage for the project audit: durable jobs, document rebuilds and security."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Chunk, Collection, Entity, IngestionJob, Observation, User


def auth(client):
    email = f"audit-{uuid.uuid4().hex}@example.com"
    token = client.post("/v1/auth/register", json={"email": email, "password": "password123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    return headers, client.get("/v1/auth/me", headers=headers).json()["id"]


@pytest.mark.parametrize("sql_error", [False, True])
def test_failed_agent_rolls_back_tools_but_keeps_failed_job(client, monkeypatch, sql_error):
    headers, uid = auth(client)

    async def broken(session, user_id, *args, **kwargs):
        col = await session.scalar(select(Collection).where(Collection.user_id == user_id))
        session.add(Entity(user_id=user_id, collection_id=col.id, domain="audit", payload={"partial": True}))
        await session.flush()
        if sql_error:
            existing = await session.get(User, user_id)
            session.add(User(email=existing.email, password_hash="unused"))
            await session.flush()
        raise RuntimeError("LLM unavailable after write")

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", broken)
    response = client.post("/v1/messages", headers=headers, json={"text": "save and fail"})
    assert response.status_code == 200, response.text
    job = response.json()
    assert job["status"] == "failed" and job["error"]
    assert client.get(f"/v1/jobs/{job['job_id']}", headers=headers).json()["status"] == "failed"

    async def check():
        async with SessionLocal() as s:
            assert await s.scalar(select(func.count()).select_from(Entity).where(Entity.user_id == uid)) == 0
    asyncio.run(check())


@pytest.mark.asyncio
async def test_force_reindex_preserves_document_content_and_failed_rebuild_rolls_back(monkeypatch):
    from app.agent.universal_tools import kb_ingest_document
    from app.rag.indexing import reindex_user
    from app.services.blobs import store_blob
    from app.services.users import bootstrap_user

    async def offline(*args, **kwargs):
        return None
    monkeypatch.setattr("app.rag.indexing._embed_texts", offline)
    async with SessionLocal() as s:
        user = await bootstrap_user(s, f"doc-{uuid.uuid4().hex}@example.com", "unused")
        blob = await store_blob(s, user.id, b"unique original document passage", "text/plain", filename="source.txt")
        doc = await kb_ingest_document(s, user.id, {"storage_key": blob.storage_key})
        uid, eid = user.id, doc["entity_id"]
        await s.commit()
    async with SessionLocal() as s:
        await reindex_user(s, uid, force=True)
        await s.commit()
        texts = (await s.scalars(select(Chunk.text).where(Chunk.entity_id == eid))).all()
        assert "unique original document passage" in texts
        entity = await s.get(Entity, eid)
        entity.payload = {**entity.payload, "storage_key": "missing"}
        await s.commit()
    async with SessionLocal() as s:
        with pytest.raises(ValueError, match="document_source_missing"):
            await reindex_user(s, uid, force=True)
        await s.rollback()
        assert "unique original document passage" in (await s.scalars(select(Chunk.text).where(Chunk.entity_id == eid))).all()


def test_llm_endpoint_policy_is_applied_to_saved_and_existing_settings(client, monkeypatch):
    from app.llm.providers import CloudLLMProvider
    headers, _ = auth(client)
    monkeypatch.setattr(get_settings(), "app_env", "production")
    monkeypatch.setattr(get_settings(), "llm_allowed_base_urls", "https://api.openai.com/v1,http://ollama:11434/v1")
    settings = {"provider_kind": "local", "default_model": "test", "base_url": "http://127.0.0.1:8000"}
    assert client.patch("/v1/settings/llm", headers=headers, json=settings).status_code == 422
    for url in ("http://169.254.169.254", "https://api.openai.com.evil.test/v1", "https://evil@api.openai.com/v1"):
        with pytest.raises(ValueError):
            CloudLLMProvider(url, None)
    settings["base_url"] = "http://ollama:11434/v1/"
    assert client.patch("/v1/settings/llm", headers=headers, json=settings).status_code == 200
    assert CloudLLMProvider(settings["base_url"], None).base_url == "http://ollama:11434/v1"


@pytest.mark.asyncio
async def test_duplicate_webhooks_create_one_job_under_concurrency(monkeypatch):
    from app.channels.common import DuplicateDelivery, submit_envelope
    from app.ingestion.schemas import Channel, IngestionEnvelope

    monkeypatch.setattr(get_settings(), "message_mode", "queue")
    async def enqueue(*args):
        pass
    from app.queue.runner import get_runner
    monkeypatch.setattr(get_runner(), "enqueue", enqueue)
    async with SessionLocal() as s:
        user = User(email=f"delivery-{uuid.uuid4().hex}@example.com", password_hash="unused")
        s.add(user)
        await s.commit()
        uid = user.id
    correlation = f"tg:1:{uuid.uuid4().hex}"
    async def deliver():
        async with SessionLocal() as s:
            user = await s.get(User, uid)
            try:
                await submit_envelope(s, user, IngestionEnvelope(channel=Channel.telegram, correlation_id=correlation, text="hello"))
                return "accepted"
            except DuplicateDelivery:
                return "duplicate"
    assert sorted(await asyncio.gather(deliver(), deliver())) == ["accepted", "duplicate"]
    async with SessionLocal() as s:
        assert await s.scalar(select(func.count()).select_from(IngestionJob).where(IngestionJob.user_id == uid)) == 1


@pytest.mark.asyncio
async def test_one_time_codes_cannot_be_consumed_concurrently():
    from app.api.v1.auth import _check_second_factor
    from app.channels.common import issue_link_code, pair_account
    from app.security.totp import generate_recovery_codes
    plain, hashes = generate_recovery_codes()
    async with SessionLocal() as s:
        user = User(email=f"codes-{uuid.uuid4().hex}@example.com", password_hash="unused", recovery_codes=hashes)
        s.add(user)
        await s.commit()
        uid = user.id
        code, _ = await issue_link_code(s, user)
    async def pair(external):
        async with SessionLocal() as s:
            return await pair_account(s, code, "telegram_user_id", external) is not None
    assert sum(await asyncio.gather(pair(uuid.uuid4().hex), pair(uuid.uuid4().hex))) == 1
    async def consume():
        async with SessionLocal() as s:
            user = await s.get(User, uid)
            accepted = await _check_second_factor(s, user, plain[0])
            await s.commit()
            return accepted
    assert sum(await asyncio.gather(consume(), consume())) == 1


@pytest.mark.asyncio
async def test_service_due_uses_each_work_item_and_preserves_overdue():
    from app.domains.automotive.handlers import auto_compute_next_due
    from app.services.users import bootstrap_user
    async with SessionLocal() as s:
        user = await bootstrap_user(s, f"car-{uuid.uuid4().hex}@example.com", "unused")
        col = await s.scalar(select(Collection).where(Collection.user_id == user.id).where(Collection.slug == "garage"))
        car = Entity(user_id=user.id, collection_id=col.id, domain="automotive", payload={
            "type": "vehicle", "odometer_km": 22000,
            "approved_maintenance_schedule": {"items": [{"name": "Oil", "interval_km": 10000}, {"name": "Filter", "interval_km": 15000}]},
        })
        s.add(car)
        await s.flush()
        for year, mileage, work in ((2024, 11000, "oil"), (2025, 20000, "filter")):
            s.add(Observation(user_id=user.id, entity_id=car.id, kind="service_event", occurred_at=datetime(year, 1, 1, tzinfo=timezone.utc),
                              payload={"odometer_km": mileage, "work_items": [{"name": work}]}))
        await s.flush()
        result = await auto_compute_next_due(s, user.id, {"vehicle_entity_id": car.id})
        items = {row["item"]: row for row in result["items"]}
        assert items["Oil"]["next_odometer_km_target"] == 21000
        assert items["Oil"]["km_until_due"] == -1000
        assert items["Filter"]["next_odometer_km_target"] == 35000


def test_postgres_password_special_characters_are_encoded():
    from sqlalchemy.engine import make_url

    from app.config import Settings
    settings = Settings(postgres_host="db", postgres_password="a:@/% password", _env_file=None)
    assert make_url(settings.database_url).password == "a:@/% password"


@pytest.mark.asyncio
async def test_rekey_with_wrong_key_keeps_original_ciphertext(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet, InvalidToken
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models import Base, ChatTurn, Conversation
    from app.security.rekey import rekey_database

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'wrong-key.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr("app.security.rekey.SessionLocal", factory)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    old = Fernet.generate_key().decode()
    monkeypatch.setattr(get_settings(), "pia_agent_secret", old)
    async with factory() as s:
        user = User(email="rekey@example.com", password_hash="unused")
        s.add(user)
        await s.flush()
        conv = Conversation(user_id=user.id)
        s.add(conv)
        await s.flush()
        s.add(ChatTurn(user_id=user.id, conversation_id=conv.id, role="user", content="keep me"))
        await s.commit()
        original = await s.scalar(text("SELECT content FROM chat_turns"))
    monkeypatch.setattr(get_settings(), "pia_agent_secret", Fernet.generate_key().decode())
    with pytest.raises(InvalidToken):
        await rekey_database()
    async with factory() as s:
        assert await s.scalar(text("SELECT content FROM chat_turns")) == original
    monkeypatch.setattr(get_settings(), "pia_agent_secret", f"{get_settings().pia_agent_secret},{old}")
    assert (await rekey_database())["chat_turns"] == 1
    async with factory() as s:
        assert await s.scalar(select(ChatTurn.content)) == "keep me"
    await engine.dispose()


def test_mcp_rejects_invalid_tool_schema_before_writes(client):
    headers, _ = auth(client)
    # Explicitly grant MCP to isolate schema validation from the privacy gate.
    assert client.put("/v1/privacy/integrations", headers=headers, json={
        "allow_remote_stt": False, "allow_mcp_access": True,
    }).status_code == 200
    response = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1,
        "method": "tools/call", "params": {"name": "kb_create_entity", "arguments": {"payload": []}}})
    assert response.status_code == 200
    assert response.json()["result"]["isError"]
    assert "invalid_arguments" in response.json()["result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_extracted_facts_require_confirmation_without_ingestion_job():
    from app.models import ExtractedFact
    from app.services.facts import stage_or_commit_observation
    from app.services.users import bootstrap_user
    async with SessionLocal() as s:
        user = await bootstrap_user(s, f"confirm-{uuid.uuid4().hex}@example.com", "unused")
        col = await s.scalar(select(Collection).where(Collection.user_id == user.id))
        entity = Entity(user_id=user.id, collection_id=col.id, domain="audit", payload={})
        s.add(entity)
        await s.flush()
        out = await stage_or_commit_observation(s, user.id, entity_id=entity.id, kind="lab_report",
            occurred_at=datetime.now(timezone.utc), payload={}, summary="review", needs_confirmation=True)
        assert out["status"] == "pending_user_confirm"
        fact = await s.get(ExtractedFact, out["fact_id"])
        assert fact.job_id is None
        assert await s.scalar(select(func.count()).select_from(Observation).where(Observation.entity_id == entity.id)) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["value", "type", "key", "result"])
async def test_tool_failure_rolls_back_only_its_own_writes(failure):
    from app.agent.orchestrator import _run_tool
    async with SessionLocal() as s:
        prefix = uuid.uuid4().hex
        prior = User(email=f"prior-{prefix}@example.com", password_hash="unused")
        s.add(prior)
        await s.flush()
        async def handler(session, uid, args):
            session.add(User(email=f"failed-{prefix}@example.com", password_hash="unused"))
            await session.flush()
            if failure == "result":
                return {"error": "rejected"}
            raise {"value": ValueError, "type": TypeError, "key": KeyError}[failure]("after write")
        result = await _run_tool(handler, s, prior.id, "probe", {})
        assert result.get("error")
        await s.commit()
    async with SessionLocal() as s:
        emails = (await s.scalars(select(User.email).where(User.email.like(f"%{prefix}@example.com")))).all()
        assert emails == [f"prior-{prefix}@example.com"]


@pytest.mark.asyncio
async def test_successful_tool_savepoint_does_not_commit_outer_transaction():
    from app.agent.orchestrator import _run_tool
    email = f"rollback-{uuid.uuid4().hex}@example.com"
    async with SessionLocal() as s:
        async def handler(session, uid, args):
            session.add(User(email=email, password_hash="unused"))
            await session.flush()
            return {"status": "created"}
        await _run_tool(handler, s, "probe", "probe", {})
        await s.rollback()
    async with SessionLocal() as s:
        assert await s.scalar(select(User.id).where(User.email == email)) is None


@pytest.mark.asyncio
async def test_maintenance_unknown_history_ids_and_fixed_milestones():
    from app.domains.automotive.handlers import auto_compute_next_due
    from app.services.users import bootstrap_user
    async with SessionLocal() as s:
        user = await bootstrap_user(s, f"due-{uuid.uuid4().hex}@example.com", "unused")
        col = await s.scalar(select(Collection).where(Collection.user_id == user.id))
        items = [
            {"name": "Oil", "item_id": "oil", "interval_km": 10000},
            {"name": "Missing", "interval_km": 10000},
            {"name": "Milestone", "basis": "fixed_milestones", "baseline_odometer_km": 11000, "interval_km": 10000},
        ]
        car = Entity(user_id=user.id, collection_id=col.id, domain="automotive", payload={
            "type": "vehicle", "odometer_km": 22000, "approved_maintenance_schedule": {"items": items}})
        s.add(car)
        await s.flush()
        s.add(Observation(user_id=user.id, entity_id=car.id, kind="service_event", occurred_at=datetime.now(timezone.utc),
            payload={"odometer_km": 11000, "work_items": [{"name": "Замена масла", "item_id": "oil"}]}))
        await s.flush()
        rows = (await auto_compute_next_due(s, user.id, {"vehicle_entity_id": car.id}))["items"]
        assert rows[0]["next_odometer_km_target"] == 21000
        assert rows[0]["km_until_due"] == -1000
        assert rows[1]["status"] == "unknown_history" and rows[1]["next_odometer_km_target"] is None
        assert rows[2]["next_odometer_km_target"] == 20000 and rows[2]["km_until_due"] == -2000


@pytest.mark.asyncio
async def test_same_width_incompatible_embeddings_are_not_compared(monkeypatch):
    from app.models import LLMSettings
    from app.rag.identity import embedding_space
    from app.rag.search import _json_vector_hits, _text_hits
    from app.services.users import bootstrap_user
    async with SessionLocal() as s:
        user = await bootstrap_user(s, f"space-{uuid.uuid4().hex}@example.com", "unused")
        uid = user.id
        space = await embedding_space(s, uid)
        s.add(Chunk(user_id=uid, text="original passage", embedding=[1., 0.], embedding_space=space))
        await s.flush()
        assert len(await _json_vector_hits(s, uid, [1., 0.], 5)) == 1
        row = await s.get(LLMSettings, uid)
        row.embedding_model = "different-model-same-width"
        await s.flush()
        assert await _json_vector_hits(s, uid, [1., 0.], 5) == []
        assert len(await _text_hits(s, uid, "passage", 5)) == 1
