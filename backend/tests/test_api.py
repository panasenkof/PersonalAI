from __future__ import annotations

import pytest
from starlette.testclient import TestClient


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_register_and_login(client: TestClient, random_email: str) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    assert r.status_code == 200
    token = r.json()["access_token"]
    r2 = client.post("/v1/auth/token", json={"email": random_email, "password": "secret1234"})
    assert r2.status_code == 200
    assert r2.json()["access_token"]


def test_message_with_mocked_agent(client: TestClient, random_email: str, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run(session, user_id: str, user_visible_text: str):
        _ = (session, user_id, user_visible_text)
        return {"assistant_text": "Сохранено (тест).", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)

    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r2 = client.post(
        "/v1/messages",
        json={"text": "Привет"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 200
    body = r2.json()
    assert body["status"] == "completed"
    assert "Сохранено" in (body.get("assistant_text") or "")


def test_telegram_link_code_requires_auth(client: TestClient) -> None:
    r = client.post("/v1/channels/telegram/link-code")
    assert r.status_code == 401
