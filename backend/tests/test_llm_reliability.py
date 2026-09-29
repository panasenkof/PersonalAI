"""Retry/backoff, streaming of tool calls, and per-user LLM quota."""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.llm import providers as providers_mod
from app.llm.providers import ChatMessage, OpenAICompatibleProvider
from app.net.retry import backoff_delay, is_retryable, with_retry

_RealClient = httpx.AsyncClient


def _install_transport(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return _RealClient(*args, **kwargs)

    monkeypatch.setattr(providers_mod.httpx, "AsyncClient", factory)


def _sse(*chunks: dict[str, Any]) -> bytes:
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return body.encode()


def test_backoff_grows_is_capped_and_honors_retry_after() -> None:
    assert backoff_delay(1, 1.0, 30.0, hint=7.0) == 7.0
    assert backoff_delay(1, 1.0, 30.0, hint=999.0) == 30.0
    assert 0.5 <= backoff_delay(1, 1.0, 30.0) <= 1.0
    assert 2.0 <= backoff_delay(3, 1.0, 30.0) <= 4.0
    assert backoff_delay(10, 1.0, 5.0) <= 5.0


@pytest.mark.asyncio
async def test_with_retry_retries_transient_and_stops_on_client_errors() -> None:
    calls = {"n": 0}

    async def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("boom")
        return "ok"

    assert await with_retry(flaky, attempts=4, base_delay=0) == "ok"
    assert calls["n"] == 3

    calls["n"] = 0
    req = httpx.Request("POST", "http://x")

    async def bad_request() -> None:
        calls["n"] += 1
        raise httpx.HTTPStatusError("400", request=req, response=httpx.Response(400, request=req))

    with pytest.raises(httpx.HTTPStatusError):
        await with_retry(bad_request, attempts=4, base_delay=0)
    assert calls["n"] == 1, "4xx must not be retried"
    assert is_retryable(httpx.HTTPStatusError("x", request=req, response=httpx.Response(429, request=req)))
    assert not is_retryable(ValueError("nope"))


@pytest.mark.asyncio
async def test_provider_retries_5xx_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["n"] += 1
        if seen["n"] == 1:
            return httpx.Response(503, json={"error": "busy"})
        if seen["n"] == 2:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "hi"}}]})

    _install_transport(monkeypatch, handler)
    res = await OpenAICompatibleProvider("http://llm/v1", "k").chat([ChatMessage(role="user", content="x")], model="m")
    assert res.message.content == "hi"
    assert seen["n"] == 3


@pytest.mark.asyncio
async def test_stream_chat_reports_tool_call_deltas_and_retries_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["n"] += 1
        if seen["n"] == 1:
            return httpx.Response(502)
        body = _sse(
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "kb_search", "arguments": ""}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"query": "'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'oil"}'}}]}}]},
        )
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    _install_transport(monkeypatch, handler)
    deltas: list[tuple[int, str, str]] = []
    res = await OpenAICompatibleProvider("http://llm/v1", None).stream_chat(
        [ChatMessage(role="user", content="x")],
        model="m",
        tools=[{"type": "function", "function": {"name": "kb_search", "parameters": {}}}],
        on_tool_delta=lambda i, n, f: deltas.append((i, n, f)),
    )
    assert seen["n"] == 2
    assert [d[2] for d in deltas if d[2]] == ['{"query": "', 'oil"}']
    assert all(d[1] == "kb_search" for d in deltas)
    call = res.message.tool_calls[0]  # type: ignore[index]
    assert call["function"]["arguments"] == '{"query": "oil"}'


@pytest.mark.asyncio
async def test_stream_error_after_output_is_not_silently_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Broken(httpx.AsyncByteStream):
        async def __aiter__(self):  # type: ignore[override]
            yield b'data: {"choices": [{"delta": {"content": "par"}}]}\n\n'
            raise httpx.ReadError("connection reset")

    seen = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["n"] += 1
        return httpx.Response(200, stream=_Broken())

    _install_transport(monkeypatch, handler)
    tokens: list[str] = []
    with pytest.raises(httpx.ReadError):
        await OpenAICompatibleProvider("http://llm/v1", None).stream_chat(
            [ChatMessage(role="user", content="x")], model="m", on_token=tokens.append
        )
    assert tokens == ["par"]
    assert seen["n"] == 1, "must not restart a stream the client already saw"


@pytest.mark.asyncio
async def test_orchestrator_emits_tool_events(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.agent import orchestrator
    from app.db import SessionLocal, init_db
    from app.llm.providers import LLMCompletionResult
    from app.models import User

    class Scripted(OpenAICompatibleProvider):
        def __init__(self) -> None:
            super().__init__("http://x", None)
            self.turn = 0

        async def stream_chat(self, messages, *, on_token=None, on_tool_delta=None, **kw):  # type: ignore[override]
            self.turn += 1
            if self.turn == 1:
                await on_tool_delta(0, "kb_list_entities", '{"limit": 3}')  # type: ignore[misc]
                msg = ChatMessage(
                    role="assistant",
                    tool_calls=[{"id": "1", "type": "function",
                                 "function": {"name": "kb_list_entities", "arguments": '{"limit": 3}'}}],
                )
            else:
                await on_token("Готово")  # type: ignore[misc]
                msg = ChatMessage(role="assistant", content="Готово")
            return LLMCompletionResult(message=msg, raw={})

    prov = Scripted()

    async def fake_provider(session, user_id):
        return prov

    async def fake_model(session, user_id):
        return "m"

    monkeypatch.setattr(orchestrator, "provider_for_user", fake_provider)
    monkeypatch.setattr(orchestrator, "default_model_for_user", fake_model)
    await init_db()
    events: list[dict[str, Any]] = []

    async def emit(e: dict[str, Any]) -> None:
        events.append(e)

    async with SessionLocal() as s:
        u = User(email=f"o{uuid.uuid4().hex[:6]}@t.dev", password_hash="x")
        s.add(u)
        await s.commit()
        out = await orchestrator.run_agent(s, u.id, "list", emit=emit)
    assert out["assistant_text"] == "Готово"
    types = [e["type"] for e in events]
    assert types == ["tool_call", "tool_start", "tool", "token"]
    tool = events[2]
    assert tool["name"] == "kb_list_entities" and tool["ok"] is True and "ms" in tool


def test_llm_quota_returns_429_with_retry_after(client: TestClient, random_email: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings
    from app.llm import limits

    async def fake_run(session, user_id, text, conversation_id=None, emit=None):
        return {"assistant_text": "ок", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)
    monkeypatch.setattr(get_settings(), "rate_limit_llm_per_minute", 2)
    limits.reset_llm_limiter()
    try:
        tok = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"}).json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        codes = [client.post("/v1/messages", json={"text": f"m{i}"}, headers=h) for i in range(3)]
        assert [c.status_code for c in codes[:2]] == [200, 200]
        assert codes[2].status_code == 429
        assert int(codes[2].headers["Retry-After"]) > 0
    finally:
        limits.reset_llm_limiter()
