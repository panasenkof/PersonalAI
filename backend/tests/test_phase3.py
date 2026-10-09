from __future__ import annotations

import asyncio

import pytest
from starlette.testclient import TestClient

from app.domains.medical_labs.handlers import labs_get_trends, labs_record_report


def test_refresh_token_flow(client: TestClient, random_email: str) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    body = r.json()
    assert body["refresh_token"], "register must issue a refresh token"

    # refresh → new pair
    r2 = client.post("/v1/auth/refresh", json={"refresh_token": body["refresh_token"]})
    assert r2.status_code == 200
    fresh = r2.json()
    r3 = client.get(
        "/v1/settings/llm", headers={"Authorization": f"Bearer {fresh['access_token']}"}
    )
    assert r3.status_code == 200

    # a refresh token is NOT a valid access token
    r4 = client.get(
        "/v1/settings/llm", headers={"Authorization": f"Bearer {body['refresh_token']}"}
    )
    assert r4.status_code == 401

    # garbage refresh token rejected
    r5 = client.post("/v1/auth/refresh", json={"refresh_token": "not-a-jwt"})
    assert r5.status_code == 401


def test_auth_rate_limit(client: TestClient, monkeypatch) -> None:
    import app.main as main_mod
    from app.config import get_settings
    from app.security.ratelimit import SlidingWindowLimiter

    class _S:
        rate_limit_auth_per_minute = 2
        cors_origin_list = ["*"]

    monkeypatch.setattr(main_mod, "_settings", _S())
    monkeypatch.setattr(main_mod, "_access_limiter", SlidingWindowLimiter(limit=2))
    monkeypatch.setattr(get_settings(), "redis_url", "")  # exercise the in-process limiter even when CI has Redis

    import uuid

    codes = []
    for i in range(4):
        r = client.post(
            "/v1/auth/register",
            json={"email": f"rl{i}-{uuid.uuid4().hex[:8]}@example.com", "password": "secret1234"},
        )
        codes.append(r.status_code)
    assert codes[:2] == [200, 200]
    assert codes[2:] == [429, 429]


def test_stats_endpoint(client: TestClient, random_email: str, monkeypatch) -> None:
    async def fake_run(session, user_id, text, conversation_id=None, emit=None):
        return {"assistant_text": "ок", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    r2 = client.post("/v1/messages", json={"text": "привет"}, headers=headers)
    assert r2.status_code == 200

    r3 = client.get("/v1/stats", headers=headers)
    assert r3.status_code == 200
    stats = r3.json()
    assert stats["jobs"].get("completed", 0) >= 1
    assert stats["conversations"] >= 1
    assert stats["chat_turns"] >= 2
    assert "usage_tokens" in stats


@pytest.mark.asyncio
async def test_labs_record_and_trends_unit() -> None:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.llm.providers import ChatMessage, LLMCompletionResult, LocalLLMProvider
    from app.models import Base
    from app.services.users import bootstrap_user

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    S = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    class FakeP(LocalLLMProvider):
        def __init__(self) -> None:
            self.base_url = "http://127.0.0.1:11434/v1"

        async def text_json_schema(self, *, model, system, user, json_schema_name, json_schema):
            import re

            m = re.search(r"Глюкоза\s+([0-9]+[.,][0-9]+)", user)
            value = (m.group(1) if m else "0").replace(",", ".")
            return {
                "panel_name": "ОАК",
                "analytes": [
                    {"name": "Глюкоза", "value": value, "unit": "ммоль/л", "flag": "unknown"},
                ],
            }

        async def embed(self, texts, *, model):
            raise RuntimeError("no embed")

        async def chat(self, messages, **kw):
            return LLMCompletionResult(message=ChatMessage(role="assistant", content="x"), raw={})

    fake = FakeP()

    async def _p(*a, **kw):
        return fake

    import app.domains.medical_labs.handlers as h
    import app.llm.router as rt

    orig_h, orig_rt = h.provider_for_user, rt.provider_for_user
    h.provider_for_user = _p
    rt.provider_for_user = _p
    try:
        async with S() as s:
            u = await bootstrap_user(s, "lab@test.dev", "x")
            uid = u.id
            await s.commit()

        async with S() as s:
            out1 = await labs_record_report(
                s, uid, {"text": "Глюкоза 6.2 ммоль/л", "occurred_at": "2026-05-01"}
            )
            await s.commit()
            assert out1["status"] == "saved"

        async with S() as s:
            out2 = await labs_record_report(
                s, uid, {"text": "Глюкоза 5.0 ммоль/л", "occurred_at": "2026-08-01"}
            )
            await s.commit()
            assert out2["status"] == "saved"

        async with S() as s:
            trends = await labs_get_trends(s, uid, {"analyte": "глюкоз"})
            series = trends["series"]
            assert len(series) == 2
            assert series[0]["value"] == 6.2
            assert series[1]["value"] == 5.0
            assert series[0]["date"] == "2026-05-01"
    finally:
        h.provider_for_user = orig_h
        rt.provider_for_user = orig_rt


def test_evals_golden_set_in_pytest() -> None:
    """Golden cases run as part of the normal test suite."""
    from evals.runner import run_all

    results = asyncio.run(run_all(live=False))
    failed = [r for r in results if not r.passed]
    assert results, "no golden cases"
    assert not failed, f"failed cases: {[(r.name, r.detail) for r in failed]}"
