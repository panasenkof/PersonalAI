from __future__ import annotations

import httpx
import pytest
from starlette.testclient import TestClient

from app.llm.providers import ChatMessage, LLMCompletionResult


class RecordingProvider:
    def __init__(self):
        self.calls: list[list[ChatMessage]] = []

    async def chat(self, messages, *, model, tools=None, tool_choice=None, temperature=0.2):
        self.calls.append(list(messages))
        return LLMCompletionResult(
            message=ChatMessage(role="assistant", content=f"ответ {len(self.calls)}"),
            raw={},
        )


def test_multi_turn_history_sent_to_llm(client: TestClient, random_email: str, monkeypatch) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    # Simulate explicit owner consent for conversation history in cloud tests.
    assert client.put("/v1/privacy/conversation", headers=headers, json={
        "allow_cloud_history": True,
    }).status_code == 200

    fake = RecordingProvider()

    async def fake_provider(session, user_id, settings=None):
        return fake

    async def fake_model(session, user_id):
        return "test-model"

    monkeypatch.setattr("app.agent.orchestrator.provider_for_user", fake_provider)
    monkeypatch.setattr("app.agent.orchestrator.default_model_for_user", fake_model)

    # turn 1 — no conversation yet
    r1 = client.post("/v1/messages", json={"text": "Моя машина Toyota Camry 2020"}, headers=headers)
    assert r1.status_code == 200
    conv_id = r1.json()["conversation_id"]
    assert conv_id
    assert len(fake.calls) == 1
    # no history on first message: system + user only
    assert [m.role for m in fake.calls[0]] == ["system", "user"]

    # turn 2 — same conversation: history must be present
    r2 = client.post(
        "/v1/messages",
        json={"text": "Какая у меня машина?", "conversation_id": conv_id},
        headers=headers,
    )
    assert r2.status_code == 200
    assert r2.json()["conversation_id"] == conv_id
    assert len(fake.calls) == 2
    roles = [m.role for m in fake.calls[1]]
    assert roles == ["system", "user", "assistant", "user"]
    contents = [m.content for m in fake.calls[1]]
    assert "Toyota Camry 2020" in contents[1]
    assert "ответ 1" in contents[2]

    # conversation listing + history
    r3 = client.get("/v1/conversations", headers=headers)
    assert r3.status_code == 200
    convs = r3.json()
    assert any(c["id"] == conv_id for c in convs)
    r4 = client.get(f"/v1/conversations/{conv_id}/messages", headers=headers)
    assert r4.status_code == 200
    turns = r4.json()
    assert [t["role"] for t in turns] == ["user", "assistant", "user", "assistant"]


def test_unknown_conversation_rejected(client: TestClient, random_email: str) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r2 = client.post(
        "/v1/messages",
        json={"text": "hi", "conversation_id": "no-such-conv"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 404


def test_local_fallback_switches_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.agent import orchestrator
    from app.llm.providers import LocalLLMProvider

    class BrokenLocal(LocalLLMProvider):
        async def chat(self, messages, **kwargs):
            raise httpx.ConnectError("connection refused")

    class OkCloud:
        async def chat(self, messages, **kwargs):
            return LLMCompletionResult(message=ChatMessage(role="assistant", content="из облака"), raw={})

    calls = {}

    def fake_target(settings=None):
        calls["target"] = True
        return OkCloud(), "cloud-model"

    monkeypatch.setattr(orchestrator, "local_fallback_target", fake_target)

    async def run():
        return await orchestrator._chat_step(
            BrokenLocal(base_url="http://127.0.0.1:1/v1", api_key=None),
            "local-model",
            [ChatMessage(role="user", content="hi")],
            [],
            allow_cloud_fallback=True,
        )

    provider, model, result, _streamed = __import__("asyncio").run(run())
    assert calls.get("target") is True
    assert model == "cloud-model"
    assert result.message.content == "из облака"
    assert provider.__class__.__name__ == "OkCloud"
