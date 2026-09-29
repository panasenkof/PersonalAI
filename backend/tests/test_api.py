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
    assert r.json()["access_token"]
    r2 = client.post("/v1/auth/token", json={"email": random_email, "password": "secret1234"})
    assert r2.status_code == 200
    assert r2.json()["access_token"]


def test_message_with_mocked_agent(client: TestClient, random_email: str, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run(session, user_id: str, user_visible_text: str, conversation_id=None):
        _ = (session, user_id, user_visible_text, conversation_id)
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


def test_llm_settings_defaults(client: TestClient, random_email: str) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    r2 = client.get("/v1/settings/llm", headers=headers)
    assert r2.status_code == 200
    body = r2.json()
    assert body["provider_kind"] == "cloud"
    assert body["default_model"] == "gpt-4o-mini"
    r3 = client.patch(
        "/v1/settings/llm",
        json={
            "provider_kind": "local",
            "base_url": "http://localhost:11434/v1",
            "default_model": "llama3.2",
            "supports_vision": False,
        },
        headers=headers,
    )
    assert r3.status_code == 200
    assert r3.json()["default_model"] == "llama3.2"
