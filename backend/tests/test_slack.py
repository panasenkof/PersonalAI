from __future__ import annotations

import hashlib
import hmac
import json
import time

from starlette.testclient import TestClient

from app.channels import slack as slack_mod

SECRET = "test-slack-signing-secret"


def _signed_body(payload: dict, secret: str = SECRET, ts: str | None = None) -> tuple[bytes, dict]:
    body = json.dumps(payload).encode()
    ts = ts or str(int(time.time()))
    digest = hmac.new(secret.encode(), b"v0:" + ts.encode() + b":" + body, hashlib.sha256).hexdigest()
    return body, {
        "X-Slack-Signature": f"v0={digest}",
        "X-Slack-Request-Timestamp": ts,
        "Content-Type": "application/json",
    }


def _settings():
    class _S:
        slack_signing_secret = SECRET
        slack_bot_token = ""
        message_mode = "sync"

    return _S()


def test_url_verification(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(slack_mod, "get_settings", _settings)
    body, headers = _signed_body({"type": "url_verification", "challenge": "c123"})
    r = client.post("/v1/channels/slack/events", content=body, headers=headers)
    assert r.status_code == 200
    assert r.json() == {"challenge": "c123"}


def test_bad_signature_rejected(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(slack_mod, "get_settings", _settings)
    body = json.dumps({"type": "url_verification", "challenge": "x"}).encode()
    r = client.post(
        "/v1/channels/slack/events",
        content=body,
        headers={"X-Slack-Signature": "v0=deadbeef", "X-Slack-Request-Timestamp": str(int(time.time()))},
    )
    assert r.status_code == 401


def test_stale_timestamp_rejected(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(slack_mod, "get_settings", _settings)
    old_ts = str(int(time.time()) - 3600)
    body, headers = _signed_body({"type": "url_verification", "challenge": "y"}, ts=old_ts)
    r = client.post("/v1/channels/slack/events", content=body, headers=headers)
    assert r.status_code == 401


def test_slack_pair_and_message_flow(client: TestClient, random_email: str, monkeypatch) -> None:
    monkeypatch.setattr(slack_mod, "get_settings", _settings)
    sent: list[str] = []

    async def fake_send(channel: str, text: str) -> None:
        sent.append(text)

    async def fake_run(session, user_id, text, conversation_id=None, emit=None):
        return {"assistant_text": "Ответ в Slack.", "raw_last": {}}

    monkeypatch.setattr(slack_mod, "send_slack_message", fake_send)
    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)

    # 1) register + link code (JWT)
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r = client.post(
        "/v1/channels/slack/link-code", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200
    code = r.json()["code"]

    # 2) pair via /start CODE (signed)
    body, headers = _signed_body(
        {
            "type": "event_callback",
            "event": {
                "type": "message",
                "user": "U12345",
                "channel": "D777",
                "text": f"/start {code}",
            },
        }
    )
    r = client.post("/v1/channels/slack/events", content=body, headers=headers)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert any("привязан" in s for s in sent)

    # 3) normal message → agent runs, reply captured
    body, headers = _signed_body(
        {
            "type": "event_callback",
            "event": {"type": "message", "user": "U12345", "channel": "D777", "text": "Привет"},
        }
    )
    r = client.post("/v1/channels/slack/events", content=body, headers=headers)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert "Ответ в Slack." in sent

    # 4) unlinked user gets guidance, not a crash
    body, headers = _signed_body(
        {
            "type": "event_callback",
            "event": {"type": "message", "user": "U99999", "channel": "D999", "text": "hi"},
        }
    )
    r = client.post("/v1/channels/slack/events", content=body, headers=headers)
    assert r.status_code == 200
    assert any("привяжите" in s for s in sent)


def test_verify_slack_signature_vectors() -> None:
    # documented behavior: correct sig passes, tampered body fails
    ts = str(int(time.time()))  # fresh timestamp (stale ones are rejected by design)
    body = b'{"a":1}'
    good = "v0=" + hmac.new(SECRET.encode(), b"v0:" + ts.encode() + b":" + body, hashlib.sha256).hexdigest()
    assert slack_mod.verify_slack_signature(ts, good, body, SECRET) is True
    assert slack_mod.verify_slack_signature(ts, good, b'{"a":2}', SECRET) is False
    assert slack_mod.verify_slack_signature(ts, None, body, SECRET) is False
    assert slack_mod.verify_slack_signature(ts, good, body, "") is False
