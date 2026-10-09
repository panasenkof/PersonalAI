"""Privacy enforcement: no unauthorized cloud model/tool/embedding egress."""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.agent.orchestrator import _chat_step, _run_tool, run_agent
from app.agent.universal_tools import kb_list_entities, kb_search
from app.llm.providers import ChatMessage, CloudLLMProvider, LLMCompletionResult, LocalLLMProvider
from app.memory.privacy import (
    cloud_allowed_collections,
    is_trusted_local_provider,
    use_cloud_scope,
)
from app.models import Base, Chunk, Collection, Entity, Observation, User
from app.rag.indexing import index_entity, index_observation


class SpyCloud(CloudLLMProvider):
    def __init__(self) -> None:
        self.base_url = "https://cloud.example/v1"
        self.embedding_requests: list[list[str]] = []
        self.chat_requests: list[list[ChatMessage]] = []
        self.last_tools = None

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        self.embedding_requests.append(list(texts))
        return [[1.0, 0.0] for _ in texts]

    async def chat(self, messages, *, model, tools=None, tool_choice=None, temperature=0.2):
        self.chat_requests.append(list(messages))
        self.last_tools = tools
        return LLMCompletionResult(message=ChatMessage(role="assistant", content="ok"), raw={})


async def _setup():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return engine, factory


async def _value(value):
    return value


@pytest.mark.asyncio
async def test_cloud_memory_tools_filter_owner_collection_and_sensitive_record(monkeypatch):
    engine, factory = await _setup()
    cloud = SpyCloud()
    monkeypatch.setattr("app.rag.indexing.provider_for_user", lambda *_args, **_kw: _value(cloud))
    monkeypatch.setattr("app.llm.router.provider_for_user", lambda *_args, **_kw: _value(cloud))
    try:
        async with factory() as session:
            alice = User(email="privacy-alice@example.net", password_hash="x")
            bob = User(email="privacy-bob@example.net", password_hash="x")
            session.add_all([alice, bob])
            await session.flush()
            allowed = Collection(
                user_id=alice.id, name="Work", slug="work", sensitivity="standard", allow_cloud_llm=True,
            )
            health = Collection(
                user_id=alice.id, name="Health", slug="health", sensitivity="sensitive",
                allow_cloud_llm=False,
            )
            unclassified = Collection(
                user_id=alice.id, name="Legacy", slug="legacy", sensitivity="unclassified",
                allow_cloud_llm=True, allow_remote_embeddings=True,
            )
            foreign = Collection(
                user_id=bob.id, name="Work", slug="work", sensitivity="standard", allow_cloud_llm=True,
            )
            session.add_all([allowed, health, unclassified, foreign])
            await session.flush()
            rows = [
                Entity(user_id=alice.id, collection_id=allowed.id, domain="notes",
                       payload={"text": "ALLOWED_ANCHOR"}),
                Entity(user_id=alice.id, collection_id=allowed.id, domain="notes",
                       payload={"text": "SENSITIVE_ANCHOR"}, sensitivity="sensitive"),
                Entity(user_id=alice.id, collection_id=health.id, domain="medical_labs",
                       payload={"text": "HEALTH_ANCHOR"}),
                Entity(user_id=alice.id, collection_id=unclassified.id, domain="notes",
                       payload={"text": "LEGACY_ANCHOR"}),
                Entity(user_id=bob.id, collection_id=foreign.id, domain="notes",
                       payload={"text": "FOREIGN_ANCHOR"}),
            ]
            session.add_all(rows)
            await session.flush()
            for entity in rows:
                await index_entity(session, entity.user_id, entity)
            await session.commit()

        async with factory() as session:
            grants = await cloud_allowed_collections(session, alice.id)
            assert grants == frozenset({allowed.id})
            assert await cloud_allowed_collections(session, bob.id) == frozenset({foreign.id})
            with use_cloud_scope(grants):
                result = await kb_list_entities(session, alice.id, {})
                assert [e["id"] for e in result["entities"]] == [rows[0].id]
                assert (await kb_list_entities(session, alice.id, {"domain": "medical_labs"}))["entities"] == []
                for term in ("HEALTH_ANCHOR", "SENSITIVE_ANCHOR", "LEGACY_ANCHOR", "FOREIGN_ANCHOR"):
                    assert (await kb_search(session, alice.id, {"query": term}))["hits"] == []
                assert (await kb_search(session, alice.id, {"query": "ALLOWED_ANCHOR"}))["hits"]
                async def should_not_run(*_args):
                    pytest.fail("Unsafe domain/tool handler was executed")
                denied = await _run_tool(should_not_run, session, alice.id, "labs_get_trends", {})
                assert denied == {"error": "cloud_memory_tool_denied"}
            # Restored context cannot contaminate a local/direct authenticated operation.
            assert len((await kb_list_entities(session, alice.id, {}))["entities"]) == 4
            assert cloud.embedding_requests == []
            chunks = (await session.scalars(select(Chunk).where(Chunk.user_id == alice.id))).all()
            assert chunks and all(c.embedding is None for c in chunks)

            # The owner can explicitly permit remote embeddings, separately from chat access.
            current_allowed = await session.get(Collection, allowed.id)
            assert current_allowed is not None
            current_allowed.allow_remote_embeddings = True
            await session.flush()
            await index_entity(session, alice.id, rows[0])
            assert len(cloud.embedding_requests) == 1
            assert "ALLOWED_ANCHOR" in cloud.embedding_requests[-1][0]
            # Explicit sensitive overrides must block embeddings even under an allowed collection.
            await index_entity(session, alice.id, rows[1])
            assert len(cloud.embedding_requests) == 1
            observation = Observation(
                user_id=alice.id, entity_id=rows[0].id, kind="note",
                occurred_at=datetime.now(timezone.utc),
                payload={"text": "PRIVATE_OBSERVATION"}, sensitivity="sensitive",
            )
            session.add(observation)
            await session.flush()
            await index_observation(session, alice.id, observation)
            assert len(cloud.embedding_requests) == 1
            with use_cloud_scope(grants):
                assert (await kb_search(session, alice.id, {"query": "PRIVATE_OBSERVATION"}))["hits"] == []
            assert await cloud_allowed_collections(session, alice.id, embeddings=True) == frozenset({allowed.id})
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_cloud_agent_does_not_send_conversation_history_or_unsafe_tools(monkeypatch):
    engine, factory = await _setup()
    cloud = SpyCloud()
    monkeypatch.setattr("app.agent.orchestrator.provider_for_user", lambda *_args: _value(cloud))
    monkeypatch.setattr("app.agent.orchestrator.default_model_for_user", lambda *_args: _value("model"))
    async def forbidden_history(*_args, **_kw):
        pytest.fail("Conversation history was loaded for unconsented cloud model")
    monkeypatch.setattr("app.agent.orchestrator.load_history_messages", forbidden_history)
    try:
        async with factory() as session:
            alice = User(email="no-history@example.org", password_hash="x")
            session.add(alice)
            await session.flush()
            result = await run_agent(
                session, alice.id, "Hello", conversation_id="pretend-previous-conversation",
            )
            assert result["assistant_text"] == "ok"
            assert cloud.last_tools == []
            assert len(cloud.chat_requests) == 1
            assert [m.role for m in cloud.chat_requests[0]] == ["system", "user"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_cloud_history_and_collection_consent_api(client, random_email):
    first = client.post("/v1/auth/register", json={
        "email": random_email, "password": "secret1234",
    })
    assert first.status_code == 200
    headers = {"Authorization": f"Bearer {first.json()['access_token']}"}
    listing = client.get("/v1/privacy/collections", headers=headers)
    assert listing.status_code == 200
    by_slug = {x["slug"]: x for x in listing.json()}
    assert by_slug["garage"]["allow_cloud_llm"] is False
    assert by_slug["health"]["allow_remote_embeddings"] is False
    assert client.get("/v1/privacy/conversation", headers=headers).json() == {
        "allow_cloud_history": False
    }

    blocked = client.put("/v1/privacy/collections/garage", headers=headers, json={
        "sensitivity": "unclassified", "allow_cloud_llm": True,
    })
    assert blocked.status_code == 422
    blocked_secret = client.put("/v1/privacy/collections/garage", headers=headers, json={
        "sensitivity": "secret", "allow_cloud_llm": True,
    })
    assert blocked_secret.status_code == 422
    updated = client.put("/v1/privacy/collections/garage", headers=headers, json={
        "sensitivity": "standard", "allow_cloud_llm": True, "allow_remote_embeddings": False,
    })
    assert updated.status_code == 200 and updated.json()["allow_cloud_llm"] is True
    assert updated.json()["allow_remote_embeddings"] is False

    second = client.post("/v1/auth/register", json={
        "email": "other-" + random_email, "password": "secret1234",
    })
    other_headers = {"Authorization": f"Bearer {second.json()['access_token']}"}
    assert client.get("/v1/privacy/collections", headers=other_headers).json()[0]["allow_cloud_llm"] is False
    assert client.put("/v1/privacy/collections/not-a-collection", headers=other_headers, json={
        "sensitivity": "standard",
    }).status_code == 404
    assert client.put("/v1/privacy/conversation", headers=headers, json={
        "allow_cloud_history": True,
    }).json() == {"allow_cloud_history": True}
    assert client.get("/v1/privacy/conversation", headers=other_headers).json() == {
        "allow_cloud_history": False
    }
    assert client.get("/v1/privacy/collections").status_code == 401


@pytest.mark.asyncio
async def test_local_flag_at_remote_url_and_agent_fallback_do_not_leak(monkeypatch):
    class LocalFailure(LocalLLMProvider):
        def __init__(self):
            self.base_url = "http://127.0.0.1:11434/v1"

        async def chat(self, messages, *, model, tools=None, tool_choice=None, temperature=0.2):
            raise httpx.ConnectError("server offline")

    local = LocalFailure()
    assert is_trusted_local_provider(local)
    local.base_url = "https://untrusted.example/v1"
    assert not is_trusted_local_provider(local)
    local.base_url = "http://127.0.0.1:11434/v1"

    def forbidden_cloud_fallback():
        pytest.fail("Attempted fallback to cloud after preparing tool-capable agent context")
    monkeypatch.setattr("app.agent.orchestrator.local_fallback_target", forbidden_cloud_fallback)
    with pytest.raises(httpx.ConnectError):
        await _chat_step(
            local, "model", [ChatMessage(role="user", content="private")],
            tools=[{"type": "function", "function": {"name": "kb_search"}}],
        )
    # Even a plain chat cannot silently send the prompt to the fallback cloud.
    with pytest.raises(httpx.ConnectError):
        await _chat_step(
            local, "model", [ChatMessage(role="user", content="private")], tools=[],
        )
