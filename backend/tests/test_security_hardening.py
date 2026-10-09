"""2FA, roles, token revocation, key rotation, encryption at rest, fail-closed webhooks."""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from starlette.testclient import TestClient

from app.config import Settings, get_settings, production_problems
from app.security import totp


def _register(client: TestClient, email: str, password: str = "secret1234") -> dict[str, str]:
    r = client.post("/v1/auth/register", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def _fresh_login_limiter():
    from app.api.v1.auth import reset_login_limiter

    reset_login_limiter()
    yield
    reset_login_limiter()


def test_totp_matches_rfc6238_vector_and_window() -> None:
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # ASCII "12345678901234567890"
    assert totp.totp_at(secret, at=59) == "287082"  # RFC 6238 (SHA-1) → 94287082, last 6 digits
    assert totp.verify_totp(secret, "287082", at=59)
    assert totp.verify_totp(secret, "287082", at=59 + 30)  # one step of clock skew tolerated
    assert not totp.verify_totp(secret, "287082", at=59 + 300)
    assert not totp.verify_totp(secret, "abcdef", at=59)


def test_recovery_codes_are_single_use_and_hashed() -> None:
    plain, hashes = totp.generate_recovery_codes(3)
    assert len(set(plain)) == 3 and all(p not in hashes for p in plain)
    rest = totp.consume_recovery_code(hashes, plain[0])
    assert rest is not None and len(rest) == 2
    assert totp.consume_recovery_code(rest, plain[0]) is None


def test_two_factor_flow_end_to_end(client: TestClient, random_email: str) -> None:
    tok = _register(client, random_email)["access_token"]
    setup = client.post("/v1/auth/2fa/setup", headers=_h(tok)).json()
    secret = setup["secret"]
    assert setup["otpauth_uri"].startswith("otpauth://totp/")

    assert client.post("/v1/auth/2fa/enable", json={"code": "not-a-code"}, headers=_h(tok)).status_code == 401
    activation_code = totp.totp_at(secret)
    en = client.post("/v1/auth/2fa/enable", json={"code": activation_code}, headers=_h(tok))
    assert en.status_code == 200
    recovery = en.json()["recovery_codes"]
    assert len(recovery) >= 4

    creds = {"email": random_email, "password": "secret1234"}
    r = client.post("/v1/auth/token", json=creds)
    assert r.status_code == 401 and r.json()["detail"] == "otp_required"
    assert client.post("/v1/auth/token", json={**creds, "otp": "not-a-code"}).status_code == 401
    # Replay the EXACT code used during enrollment. Recomputing totp_at()
    # can cross a 30-second boundary and generate a legitimate *new* code.
    assert client.post("/v1/auth/token", json={**creds, "otp": activation_code}).status_code == 401
    nxt = totp.totp_at(secret, at=time.time() + totp.STEP_SECONDS)
    ok = client.post("/v1/auth/token", json={**creds, "otp": nxt})
    assert ok.status_code == 200
    assert client.post("/v1/auth/token", json={**creds, "otp": nxt}).status_code == 401

    # a recovery code works once
    assert client.post("/v1/auth/token", json={**creds, "otp": recovery[0]}).status_code == 200
    assert client.post("/v1/auth/token", json={**creds, "otp": recovery[0]}).status_code == 401

    me = client.get("/v1/auth/me", headers=_h(ok.json()["access_token"])).json()
    assert me["totp_enabled"] is True

    # disabling needs password + a valid second factor
    bad = client.post("/v1/auth/2fa/disable", json={"password": "wrong", "code": totp.totp_at(secret)},
                      headers=_h(tok))
    assert bad.status_code == 401
    good = client.post("/v1/auth/2fa/disable", json={"password": "secret1234", "code": recovery[1]},
                       headers=_h(tok))
    assert good.status_code == 200
    assert client.post("/v1/auth/token", json=creds).status_code == 200


def test_login_lockout_after_repeated_failures(client: TestClient, random_email: str, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "login_max_failures", 3)
    _register(client, random_email)
    bad = {"email": random_email, "password": "nope-nope"}
    assert [client.post("/v1/auth/token", json=bad).status_code for _ in range(3)] == [401, 401, 401]
    assert client.post("/v1/auth/token", json=bad).status_code == 429
    # even the correct password is refused while locked — brute force protection
    assert client.post("/v1/auth/token", json={"email": random_email, "password": "secret1234"}).status_code == 429


def test_logout_all_and_password_change_revoke_tokens(client: TestClient, random_email: str) -> None:
    pair = _register(client, random_email)
    assert client.get("/v1/auth/me", headers=_h(pair["access_token"])).status_code == 200
    # refresh token is not an access token
    assert client.get("/v1/auth/me", headers=_h(pair["refresh_token"])).status_code == 401

    assert client.post("/v1/auth/logout-all", headers=_h(pair["access_token"])).status_code == 204
    assert client.get("/v1/auth/me", headers=_h(pair["access_token"])).status_code == 401
    assert client.post("/v1/auth/refresh", json={"refresh_token": pair["refresh_token"]}).status_code == 401

    fresh = client.post("/v1/auth/token", json={"email": random_email, "password": "secret1234"}).json()
    ch = client.post(
        "/v1/auth/password",
        json={"current_password": "secret1234", "new_password": "another-pass-9"},
        headers=_h(fresh["access_token"]),
    )
    assert ch.status_code == 200
    assert client.get("/v1/auth/me", headers=_h(fresh["access_token"])).status_code == 401
    assert client.get("/v1/auth/me", headers=_h(ch.json()["access_token"])).status_code == 200


def test_jwt_secret_rotation_keeps_old_tokens_valid_until_removed(
    client: TestClient, random_email: str, monkeypatch
) -> None:
    old = get_settings().jwt_secret
    tok = _register(client, random_email)["access_token"]
    monkeypatch.setattr(get_settings(), "jwt_secret", "brand-new-secret-brand-new-secret-99")
    monkeypatch.setattr(get_settings(), "jwt_secret_previous", old)
    assert client.get("/v1/auth/me", headers=_h(tok)).status_code == 200  # signed with the previous key
    new_tok = client.post("/v1/auth/token", json={"email": random_email, "password": "secret1234"}).json()
    assert client.get("/v1/auth/me", headers=_h(new_tok["access_token"])).status_code == 200
    monkeypatch.setattr(get_settings(), "jwt_secret_previous", "")
    assert client.get("/v1/auth/me", headers=_h(tok)).status_code == 401  # old key retired


def test_roles_and_admin_api(client: TestClient, random_email: str, monkeypatch) -> None:
    admin_email = f"boss{uuid.uuid4().hex[:6]}@example.com"
    monkeypatch.setattr(get_settings(), "admin_emails", admin_email.upper())
    admin = _register(client, admin_email)["access_token"]
    user = _register(client, random_email)["access_token"]
    assert client.get("/v1/auth/me", headers=_h(admin)).json()["role"] == "user"
    # Elevation is available only to a trusted server-side provisioning command.
    from app.db import SessionLocal
    from app.security.admin import grant_admin
    admin_id = client.get("/v1/auth/me", headers=_h(admin)).json()["id"]
    async def provision():
        async with SessionLocal() as s:
            await grant_admin(s, admin_id)
            await s.commit()
    asyncio.run(provision())
    assert client.get("/v1/auth/me", headers=_h(admin)).json()["role"] == "admin"
    assert client.get("/v1/auth/me", headers=_h(user)).json()["role"] == "user"

    assert client.get("/v1/admin/users", headers=_h(user)).status_code == 403
    assert client.get("/v1/admin/users").status_code == 401
    users = client.get("/v1/admin/users", headers=_h(admin)).json()["users"]
    target = next(u for u in users if u["email"] == random_email)

    # cannot lock yourself out
    me_id = client.get("/v1/auth/me", headers=_h(admin)).json()["id"]
    assert client.patch(f"/v1/admin/users/{me_id}", json={"role": "user"}, headers=_h(admin)).status_code == 409

    r = client.patch(f"/v1/admin/users/{target['id']}", json={"is_active": False}, headers=_h(admin))
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert client.get("/v1/auth/me", headers=_h(user)).status_code == 401  # session killed
    assert client.post("/v1/auth/token", json={"email": random_email, "password": "secret1234"}).status_code == 401
    assert "jobs" in client.get("/v1/admin/stats", headers=_h(admin)).json()


def test_encryption_at_rest_for_history_blobs_and_keys(monkeypatch, tmp_path) -> None:
    from app.db import SessionLocal, init_db
    from app.models import ChatTurn, Conversation, LLMSettings, User
    from app.storage.blob import read_bytes, save_bytes

    monkeypatch.setattr(get_settings(), "pia_agent_secret", Fernet.generate_key().decode())
    monkeypatch.setattr(get_settings(), "blob_storage_dir", str(tmp_path))

    async def scenario() -> None:
        await init_db()
        async with SessionLocal() as s:
            u = User(email=f"e{uuid.uuid4().hex[:6]}@t.dev", password_hash="x")
            s.add(u)
            await s.flush()
            conv = Conversation(user_id=u.id, title="t")
            s.add(conv)
            await s.flush()
            s.add(ChatTurn(user_id=u.id, conversation_id=conv.id, role="user", content="секретный диагноз"))
            await s.commit()
            raw = (await s.execute(text("SELECT content FROM chat_turns WHERE user_id = :u"), {"u": u.id})).scalar_one()
            assert raw.startswith("enc1:") and "диагноз" not in raw
            turn = (await s.execute(text("SELECT id FROM chat_turns WHERE user_id = :u"), {"u": u.id})).scalar_one()
            assert (await s.get(ChatTurn, turn)).content == "секретный диагноз"  # type: ignore[union-attr]

            from app.services.users import get_or_create_llm_settings

            row = await get_or_create_llm_settings(s, u.id)
            assert isinstance(row, LLMSettings)

    asyncio.run(scenario())

    key, _sha, _n = save_bytes(b"lab report PDF bytes", "application/pdf")
    on_disk = open(os.path.join(str(tmp_path), key), "rb").read()
    assert b"lab report" not in on_disk
    assert asyncio.run(read_bytes(key)) == b"lab report PDF bytes"

    # plaintext files written before encryption was enabled are still readable, and rekey encrypts them
    legacy = tmp_path / "legacy.bin"
    legacy.write_bytes(b"old plaintext")
    assert asyncio.run(read_bytes("legacy.bin")) == b"old plaintext"
    from app.security.rekey import rekey_blobs

    assert rekey_blobs() >= 1
    assert b"old plaintext" not in legacy.read_bytes()
    assert asyncio.run(read_bytes("legacy.bin")) == b"old plaintext"


def test_key_rotation_multifernet(monkeypatch) -> None:
    from app.security.crypto import decrypt_text, encrypt_text

    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    monkeypatch.setattr(get_settings(), "pia_agent_secret", old)
    ct = encrypt_text("hello")
    monkeypatch.setattr(get_settings(), "pia_agent_secret", f"{new},{old}")
    assert decrypt_text(ct) == "hello"  # old ciphertext still readable
    assert encrypt_text("x") != ct
    monkeypatch.setattr(get_settings(), "pia_agent_secret", new)
    assert decrypt_text(ct) != "hello"  # old key dropped → cannot be read


def test_production_config_validation() -> None:
    weak = Settings(app_env="production", jwt_secret="change-me-in-production-use-long-random", pia_agent_secret="",
                    telegram_bot_token="t", slack_bot_token="s", cors_origins="*", discord_bot_token="d",
                    _env_file=None)
    problems = " | ".join(production_problems(weak))
    for needle in ("JWT_SECRET", "PIA_AGENT_SECRET", "TELEGRAM_WEBHOOK_SECRET", "SLACK_SIGNING_SECRET",
                   "DISCORD_PUBLIC_KEY", "CORS_ORIGINS"):
        assert needle in problems
    strong = Settings(
        app_env="production", jwt_secret="x" * 40, pia_agent_secret=Fernet.generate_key().decode(),
        telegram_bot_token="t", telegram_webhook_secret="w", slack_bot_token="s", slack_signing_secret="z",
        cors_origins="https://app.example.com", _env_file=None,
    )
    assert production_problems(strong) == []


def test_webhooks_fail_closed_in_production(client: TestClient, monkeypatch) -> None:
    s = get_settings()
    monkeypatch.setattr(s, "app_env", "production")
    monkeypatch.setattr(s, "telegram_webhook_secret", "")
    monkeypatch.setattr(s, "slack_signing_secret", "")
    monkeypatch.setattr(s, "whatsapp_app_secret", "")
    monkeypatch.setattr(s, "discord_public_key", "")
    assert client.post("/v1/channels/telegram/webhook", json={}).status_code == 503
    assert client.post("/v1/channels/slack/events", json={"type": "url_verification", "challenge": "c"}).status_code == 503
    assert client.post("/v1/channels/whatsapp/webhook", json={}).status_code == 503
    assert client.post("/v1/channels/discord/interactions", json={"type": 1}).status_code == 503
    # development keeps the old lenient behaviour for local testing
    monkeypatch.setattr(s, "app_env", "development")
    assert client.post("/v1/channels/telegram/webhook", json={}).status_code == 200


def test_security_headers_present(client: TestClient) -> None:
    r = client.get("/health")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert client.get("/ready").json()["database"] == "ok"


def test_job_and_fact_payloads_encrypted_and_rekeyed(monkeypatch, tmp_path) -> None:
    from app.models import ExtractedFact, IngestionJob, User
    from app.security.rekey import rekey_database

    monkeypatch.setattr(get_settings(), "pia_agent_secret", "")
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.models import Base
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'rekey.db'}", poolclass=NullPool)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr("app.security.rekey.SessionLocal", SessionLocal)

    async def scenario() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with SessionLocal() as s:
            u = User(email=f"j{uuid.uuid4().hex[:6]}@t.dev", password_hash="x")
            s.add(u)
            await s.flush()
            # written before encryption was enabled -> plain JSON
            job = IngestionJob(user_id=u.id, envelope={"text": "мой анализ крови"}, result={"text": "ответ"})
            fact = ExtractedFact(user_id=u.id, payload={"summary": "гемоглобин 120"})
            s.add_all([job, fact])
            await s.commit()
            jid, fid = job.id, fact.id

        monkeypatch.setattr(get_settings(), "pia_agent_secret", Fernet.generate_key().decode())
        counts = await rekey_database()
        assert counts["jobs"] >= 1 and counts["facts"] >= 1
        async with SessionLocal() as s:
            raw_env = (await s.execute(text("SELECT envelope FROM ingestion_jobs WHERE id = :i"), {"i": jid})).scalar_one()
            raw_fact = (await s.execute(text("SELECT payload FROM extracted_facts WHERE id = :i"), {"i": fid})).scalar_one()
            assert "enc1:" in str(raw_env) and "анализ" not in str(raw_env)
            assert "enc1:" in str(raw_fact) and "гемоглобин" not in str(raw_fact)
            j = await s.get(IngestionJob, jid)
            assert j is not None and j.envelope == {"text": "мой анализ крови"} and j.result == {"text": "ответ"}
            f = await s.get(ExtractedFact, fid)
            assert f is not None and f.payload == {"summary": "гемоглобин 120"}

    asyncio.run(scenario())


def test_auth_ip_limit_ignores_spoofed_forwarded_for(client, monkeypatch) -> None:
    import app.main as main_mod
    from app.security.ratelimit import SlidingWindowLimiter

    monkeypatch.setattr(main_mod._settings, "rate_limit_auth_per_minute", 2)
    monkeypatch.setattr(get_settings(), "redis_url", "")  # in-process path even when CI has Redis
    monkeypatch.setattr(main_mod, "_access_limiter", SlidingWindowLimiter(limit=2))

    def reg(xff: str) -> int:
        return client.post(
            "/v1/auth/register",
            json={"email": f"x{uuid.uuid4().hex[:8]}@t.dev", "password": "secret1234"},
            headers={"X-Forwarded-For": xff},
        ).status_code

    # header not trusted: rotating the value must not reset the counter
    assert [reg("1.1.1.1"), reg("2.2.2.2"), reg("3.3.3.3")] == [200, 200, 429]

    # behind a trusted proxy the proxy-appended (last) hop is the key; the spoofed prefix is ignored
    monkeypatch.setattr(get_settings(), "trust_proxy_headers", True)
    monkeypatch.setattr(main_mod, "_access_limiter", SlidingWindowLimiter(limit=2))
    assert [reg("9.9.9.1, 10.0.0.7"), reg("9.9.9.2, 10.0.0.7"), reg("9.9.9.3, 10.0.0.7")] == [200, 200, 429]
    assert reg("9.9.9.1, 10.0.0.8") == 200  # a different real client is unaffected


def test_ready_does_not_leak_error_details(client, monkeypatch) -> None:
    import app.db as db_mod

    class _Boom:
        def connect(self):
            raise RuntimeError("postgresql://user:secret@internal-host/db unreachable")

    monkeypatch.setattr(db_mod, "engine", _Boom())
    r = client.get("/ready")
    assert r.status_code == 503
    assert "secret" not in r.text and "internal-host" not in r.text


def test_totp_code_cannot_be_replayed_and_recovery_codes_are_strong(client, random_email) -> None:
    from app.security import totp

    tok = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"}).json()
    h = _h(tok["access_token"])
    secret = client.post("/v1/auth/2fa/setup", headers=h).json()["secret"]
    step = int(time.time() // 30)
    enable_code = totp.totp_at(secret, at=step * 30)
    assert client.post("/v1/auth/2fa/enable", headers=h, json={"code": enable_code}).status_code == 200

    def login(code: str) -> int:
        return client.post(
            "/v1/auth/token", json={"email": random_email, "password": "secret1234", "otp": code}
        ).status_code

    assert login(enable_code) == 401  # the code that enabled 2FA is already spent
    nxt = totp.totp_at(secret, at=(step + 1) * 30)  # within the ±1 step window
    assert login(nxt) == 200
    assert login(nxt) == 401  # replay of the same code is rejected
    plain, _ = totp.generate_recovery_codes()
    assert all(len(c.replace("-", "")) == 16 for c in plain)


def test_secrets_are_redacted_from_errors_and_logs(monkeypatch) -> None:
    import logging

    from app.security.redact import RedactFilter, safe_error

    token = "123456789:AAExampleTelegramTokenValueXYZ_0123456"
    monkeypatch.setattr(get_settings(), "telegram_bot_token", token)
    url = f"https://api.telegram.org/bot{token}/getFile"
    msg = safe_error(RuntimeError(f"Client error '404' for url '{url}'"))
    assert token not in msg and "<redacted>" in msg
    assert "hunter22" not in safe_error("postgresql://pia:hunter22@db:5432/pia refused")
    assert "sk-abcdefghijk" not in safe_error("Authorization: Bearer sk-abcdefghijklmnop rejected")

    # third-party loggers (httpx prints every request URL at INFO) are scrubbed by the handler filter
    rec = logging.LogRecord("httpx", logging.INFO, __file__, 1, 'HTTP Request: POST %s "200 OK"', (url,), None)
    assert RedactFilter().filter(rec) is True
    assert token not in rec.getMessage()
