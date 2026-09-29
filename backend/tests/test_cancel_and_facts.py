"""Stop button (job cancellation), streamed tool events over SSE, extracted-fact confirmation via REST."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone

import pytest
from starlette.testclient import TestClient

from app.config import get_settings


def _auth(client: TestClient) -> dict[str, str]:
    email = f"j{uuid.uuid4().hex[:8]}@example.com"
    tok = client.post("/v1/auth/register", json={"email": email, "password": "secret1234"}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def _wait(client: TestClient, h: dict[str, str], job_id: str, wanted: set[str], timeout: float = 10.0) -> str:
    end = time.time() + timeout
    status = ""
    while time.time() < end:
        status = client.get(f"/v1/jobs/{job_id}", headers=h).json()["status"]
        if status in wanted:
            return status
        time.sleep(0.05)
    raise AssertionError(f"job stuck in {status}")


def _sse_events(text: str) -> list[dict]:
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


@pytest.fixture
def queue_mode(monkeypatch):
    monkeypatch.setattr(get_settings(), "message_mode", "queue")


def test_stop_button_cancels_running_job_and_keeps_partial_answer(client: TestClient, queue_mode, monkeypatch) -> None:
    h = _auth(client)
    started = {"n": 0}

    async def slow_agent(session, user_id, text, conversation_id=None, emit=None):
        await emit({"type": "token", "content": "Начало ответа"})
        started["n"] += 1
        await asyncio.sleep(60)  # would run for a minute
        return {"assistant_text": "never", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", slow_agent)
    r = client.post("/v1/messages", json={"text": "расскажи много"}, headers=h).json()
    job_id, conv_id = r["job_id"], r["conversation_id"]
    _wait(client, h, job_id, {"processing"})
    for _ in range(100):
        if started["n"]:
            break
        time.sleep(0.05)

    c = client.post(f"/v1/jobs/{job_id}/cancel", headers=h)
    assert c.status_code == 200 and c.json()["status"] == "cancelled"
    # settles quickly (task really cancelled — no 60 s wait), status stays cancelled
    time.sleep(0.5)
    assert client.get(f"/v1/jobs/{job_id}", headers=h).json()["status"] == "cancelled"

    turns = client.get(f"/v1/conversations/{conv_id}/messages", headers=h).json()
    assert [t["role"] for t in turns] == ["user", "assistant"]
    assert turns[1]["content"].startswith("Начало ответа") and "остановлено" in turns[1]["content"]

    ev = _sse_events(client.get(f"/v1/jobs/{job_id}/events", headers=h).text)
    assert ev[-1]["type"] == "cancelled"
    # cancelling again is a harmless no-op; foreign users cannot cancel
    assert client.post(f"/v1/jobs/{job_id}/cancel", headers=h).json()["status"] == "cancelled"
    assert client.post(f"/v1/jobs/{job_id}/cancel", headers=_auth(client)).status_code == 404


def test_cancel_before_start_skips_execution(client: TestClient, queue_mode, monkeypatch) -> None:
    h = _auth(client)
    ran = {"n": 0}

    async def agent(session, user_id, text, conversation_id=None, emit=None):
        ran["n"] += 1
        return {"assistant_text": "x", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", agent)
    from app.queue import runner as runner_mod

    async def never(job_id: str) -> None:  # queued, but not picked up yet
        return None

    monkeypatch.setattr(runner_mod.get_runner(), "enqueue", never)
    job_id = client.post("/v1/messages", json={"text": "hi"}, headers=h).json()["job_id"]
    assert client.post(f"/v1/jobs/{job_id}/cancel", headers=h).json()["status"] == "cancelled"
    asyncio.run(_run_now(job_id))
    assert ran["n"] == 0
    assert client.get(f"/v1/jobs/{job_id}", headers=h).json()["status"] == "cancelled"


async def _run_now(job_id: str) -> None:
    from app.queue.jobs import execute_job

    await execute_job(job_id)


def test_tool_events_are_streamed_and_facts_wait_for_confirmation(client: TestClient, queue_mode, monkeypatch) -> None:
    h = _auth(client)

    async def agent(session, user_id, text, conversation_id=None, emit=None):
        from sqlalchemy import select

        from app.models import Collection, Entity
        from app.services.facts import stage_or_commit_observation

        await emit({"type": "tool_call", "index": 0, "name": "auto_parse_service_receipt", "arguments_delta": "{"})
        await emit({"type": "tool_start", "name": "auto_parse_service_receipt", "arguments": "{}"})
        col = (await session.execute(select(Collection).where(Collection.user_id == user_id))).scalars().first()
        ent = Entity(user_id=user_id, collection_id=col.id, domain="automotive.vehicle", payload={})
        session.add(ent)
        await session.flush()
        res = await stage_or_commit_observation(
            session, user_id, entity_id=ent.id, kind="service_event", occurred_at=datetime.now(timezone.utc),
            payload={"odometer_km": 123456}, summary="Замена масла, 123456 км", needs_confirmation=True,
        )
        await emit({"type": "tool", "name": "auto_parse_service_receipt", "ok": True, "summary": res["status"], "ms": 3})
        await emit({"type": "token", "content": "Жду подтверждения."})
        return {"assistant_text": "Жду подтверждения.", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", agent)
    job_id = client.post("/v1/messages", json={"text": "чек"}, headers=h).json()["job_id"]
    assert _wait(client, h, job_id, {"awaiting_confirm", "completed", "failed"}) == "awaiting_confirm"

    ev = _sse_events(client.get(f"/v1/jobs/{job_id}/events", headers=h).text)
    assert ev[-1]["type"] == "done" and ev[-1]["status"] == "awaiting_confirm"
    facts = ev[-1]["pending_facts"]
    assert len(facts) == 1 and facts[0]["summary"].startswith("Замена масла")

    listed = client.get("/v1/facts", headers=h).json()["facts"]
    assert [f["id"] for f in listed] == [facts[0]["id"]]
    # nothing searchable / stored before the user decides
    fid = facts[0]["id"]
    assert client.post(f"/v1/facts/{fid}/confirm", headers=_auth(client)).status_code == 404

    ok = client.post(f"/v1/facts/{fid}/confirm", headers=h)
    assert ok.status_code == 200
    assert ok.json()["fact"]["status"] == "committed" and ok.json()["fact"]["observation_id"]
    assert ok.json()["job_status"] == "completed"
    assert client.get(f"/v1/jobs/{job_id}", headers=h).json()["status"] == "completed"
    assert client.post(f"/v1/facts/{fid}/confirm", headers=h).status_code == 409
    assert client.post(f"/v1/facts/{fid}/reject", headers=h).status_code == 409


def test_rejected_fact_never_reaches_knowledge_base(client: TestClient, monkeypatch) -> None:
    h = _auth(client)

    async def agent(session, user_id, text, conversation_id=None, emit=None):
        from sqlalchemy import select

        from app.models import Collection, Entity
        from app.services.facts import stage_or_commit_observation

        col = (await session.execute(select(Collection).where(Collection.user_id == user_id))).scalars().first()
        ent = Entity(user_id=user_id, collection_id=col.id, domain="automotive.vehicle", payload={})
        session.add(ent)
        await session.flush()
        await stage_or_commit_observation(
            session, user_id, entity_id=ent.id, kind="service_event", occurred_at=datetime.now(timezone.utc),
            payload={"odometer_km": 1}, summary="Ошибочное распознавание", needs_confirmation=True,
        )
        return {"assistant_text": "ok", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", agent)
    r = client.post("/v1/messages", json={"text": "чек"}, headers=h).json()  # sync mode
    assert r["status"] == "awaiting_confirm" and len(r["pending_facts"]) == 1
    fid = r["pending_facts"][0]["id"]
    rej = client.post(f"/v1/facts/{fid}/reject", headers=h).json()
    assert rej["fact"]["status"] == "rejected" and rej["fact"]["observation_id"] is None

    async def count() -> int:
        from sqlalchemy import func, select

        from app.db import SessionLocal
        from app.models import Observation

        async with SessionLocal() as s:
            return (await s.execute(select(func.count()).select_from(Observation).where(Observation.entity_id.is_not(None)))).scalar_one()

    before = asyncio.run(count())
    assert client.get("/v1/facts?status=rejected", headers=h).json()["facts"][0]["id"] == fid
    assert asyncio.run(count()) == before
