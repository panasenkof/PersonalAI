"""The live-eval harness against a fake OpenAI-compatible endpoint (no network, no key needed).

Real live runs happen in CI (.github/workflows/evals-live.yml) with a real model.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from app.llm import providers as providers_mod
from evals.golden import GOLDEN
from evals.runner import LiveConfig, main, run_all, summarize

_RealClient = httpx.AsyncClient

TOOL_FOR_CASE = {
    "Toyota Camry 2020": ("auto_add_vehicle", {"make": "Toyota", "model": "Camry", "year": 2020}),
    "Что у меня про Camry": ("kb_search", {"query": "Camry"}),
    "пароль от гаража": ("kb_create_entity", {"collection_slug": "garage", "domain": "notes",
                                              "payload": {"type": "note", "text": "Пароль от гаража 1234"}}),
}


def _fake_llm(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/embeddings"):
        return httpx.Response(404, json={"error": "no embeddings here"})
    payload: dict[str, Any] = json.loads(request.content)
    msgs = payload["messages"]
    user = next(m["content"] for m in msgs if m["role"] == "user")
    has_tool_result = any(m["role"] == "tool" for m in msgs)
    tool = next((v for k, v in TOOL_FOR_CASE.items() if k in user), None)
    if tool and not has_tool_result:
        message: dict[str, Any] = {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": tool[0], "arguments": json.dumps(tool[1])}}]}
    else:
        answer = "Готово: Toyota Camry, запомнил 1234." if tool else "Привет! Чем помочь?"
        message = {"role": "assistant", "content": answer}
    if payload.get("stream"):
        delta = {**message}
        if delta.get("tool_calls"):
            delta["tool_calls"] = [{"index": 0, **delta["tool_calls"][0]}]
        body = f"data: {json.dumps({'choices': [{'delta': delta}]})}\n\ndata: [DONE]\n\n"
        return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})
    return httpx.Response(200, json={"choices": [{"message": message}], "usage": {"total_tokens": 7}})


@pytest.fixture
def fake_openai(monkeypatch):
    def factory(*a: Any, **kw: Any) -> httpx.AsyncClient:
        kw["transport"] = httpx.MockTransport(_fake_llm)
        return _RealClient(*a, **kw)

    monkeypatch.setattr(providers_mod.httpx, "AsyncClient", factory)
    monkeypatch.setenv("EVAL_LLM_API_KEY", "sk-test")
    monkeypatch.setenv("EVAL_LLM_BASE_URL", "http://fake-llm/v1")


@pytest.mark.asyncio
async def test_live_mode_drives_a_real_provider_path_and_grades_trajectory(fake_openai) -> None:
    assert LiveConfig.from_env() is not None
    results = await run_all(live=True, runs=1)
    by = {r.name: r for r in results}
    # cases the fake "model" can solve pass through the genuine provider → tools → DB post-condition path
    assert by["add_vehicle"].passed and by["add_vehicle"].tools == ["auto_add_vehicle"]
    assert by["search_kb"].passed and by["remember_fact"].passed
    assert by["greeting_uses_no_tools"].passed
    # the fake model never calls lab tools → live grading must flag it instead of silently passing
    assert not by["record_lab_report"].passed and "expected tools not called" in by["record_lab_report"].detail


def test_pass_rate_threshold_tolerates_flaky_live_runs() -> None:
    from evals.runner import CaseResult

    rs = [CaseResult("a", True)] * 4 + [CaseResult("a", False, "flaky")]
    rows, ok = summarize(rs, 0.8)
    assert ok and rows[0]["pass_rate"] == 0.8
    _, ok_strict = summarize(rs, 1.0)
    assert not ok_strict


def test_cli_skips_cleanly_without_key(monkeypatch, capsys) -> None:
    monkeypatch.delenv("EVAL_LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert main(["--live"]) == 2
    monkeypatch.setenv("PIA_EVAL_ALLOW_SKIP", "1")
    assert main(["--live"]) == 0
    assert "SKIPPED" in capsys.readouterr().out
    assert len(GOLDEN) >= 6
