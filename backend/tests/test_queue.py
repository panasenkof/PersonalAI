from __future__ import annotations

import asyncio
import time

import pytest
from starlette.testclient import TestClient

from app.queue.events import EventBus


@pytest.mark.asyncio
async def test_event_bus_publish_subscribe() -> None:
    bus = EventBus()
    q = bus.subscribe("job1")
    await bus.publish("job1", {"type": "token", "content": "a"})
    await bus.publish("job1", {"type": "token", "content": "b"})
    await bus.publish("other", {"type": "token", "content": "x"})  # not delivered
    assert q.qsize() == 2
    e1 = await q.get()
    assert e1 == {"type": "token", "content": "a"}
    e2 = await q.get()
    assert e2 == {"type": "token", "content": "b"}
    bus.unsubscribe("job1", q)
    await bus.publish("job1", {"type": "token", "content": "c"})
    assert q.qsize() == 0  # unsubscribed


def _queue_settings():
    class _S:
        message_mode = "queue"
        max_upload_bytes = 10 * 1024 * 1024
        queue_concurrency = 4

    return _S()


def test_queue_mode_accept_and_process(
    client: TestClient, random_email: str, monkeypatch
) -> None:
    from app.api.v1 import messages as messages_mod

    monkeypatch.setattr(messages_mod, "get_settings", _queue_settings)

    calls = {}

    async def fake_run(session, user_id, text, conversation_id=None, emit=None):
        calls["text"] = text
        if emit:
            await emit({"type": "token", "content": "токен-1"})
        return {"assistant_text": "ответ из воркера", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)

    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    r2 = client.post("/v1/messages", json={"text": "привет очередь"}, headers=headers)
    assert r2.status_code == 200
    body = r2.json()
    # fast accept: no assistant text yet (or already done if worker was fast)
    assert body["status"] in ("accepted", "completed")
    assert body["conversation_id"]
    job_id = body["job_id"]

    # wait for the background worker
    deadline = time.time() + 10
    status = None
    while time.time() < deadline:
        rj = client.get(f"/v1/jobs/{job_id}", headers=headers)
        status = rj.json()["status"]
        if status in ("completed", "failed"):
            break
        time.sleep(0.1)
    assert status == "completed", status
    assert calls["text"] == "привет очередь"

    # SSE for a finished job yields the done event immediately
    rs = client.get(f"/v1/jobs/{job_id}/events?access_token={token}")
    assert rs.status_code == 200
    assert rs.headers["content-type"].startswith("text/event-stream")
    assert 'event: done' in rs.text
    assert "ответ из воркера" in rs.text


def test_sse_rejects_anonymous(client: TestClient) -> None:
    r = client.get("/v1/jobs/whatever/events")
    assert r.status_code == 401


def test_web_ui_served(client: TestClient) -> None:
    r = client.get("/app/", follow_redirects=True)
    assert r.status_code == 200
    assert "PIA Agent" in r.text
    r2 = client.get("/", follow_redirects=False)
    assert r2.status_code in (302, 307)
    assert r2.headers["location"] == "/app/"


@pytest.mark.asyncio
async def test_run_agent_streams_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    """Orchestrator emits token events when the provider supports streaming."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.agent.orchestrator import run_agent
    from app.llm.providers import ChatMessage, LLMCompletionResult
    from app.models import Base, User

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with Session() as session:
        u = User(email="s@test.dev", password_hash="x")
        session.add(u)
        await session.flush()
        uid = u.id

    class StreamingProvider:
        async def stream_chat(self, messages, *, model, tools=None, tool_choice=None, on_token=None, **kw):
            for piece in ["Прив", "ет, мир"]:
                if on_token:
                    res = on_token(piece)
                    if asyncio.iscoroutine(res):
                        await res
            return LLMCompletionResult(
                message=ChatMessage(role="assistant", content="Привет, мир"), raw={}
            )

    async def fake_provider(session, user_id, settings=None):
        return StreamingProvider()

    async def fake_model(session, user_id):
        return "m"

    monkeypatch.setattr("app.agent.orchestrator.provider_for_user", fake_provider)
    monkeypatch.setattr("app.agent.orchestrator.default_model_for_user", fake_model)

    events: list[dict] = []

    async def emit(ev: dict) -> None:
        events.append(ev)

    async with Session() as session:
        out = await run_agent(session, uid, "скажи привет", emit=emit)

    assert out["assistant_text"] == "Привет, мир"
    tokens = [e["content"] for e in events if e["type"] == "token"]
    assert tokens == ["Прив", "ет, мир"]
