"""Documents, confirmation buttons, threads, WhatsApp and Discord on top of the shared channel layer."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Any
from urllib.parse import urlencode

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from starlette.testclient import TestClient

from app.channels import discord as discord_mod
from app.channels import slack as slack_mod
from app.channels import telegram as telegram_mod
from app.channels import whatsapp as wa_mod
from app.config import get_settings


def _user(client: TestClient) -> tuple[str, dict[str, str]]:
    email = f"c{uuid.uuid4().hex[:8]}@example.com"
    tok = client.post("/v1/auth/register", json={"email": email, "password": "secret1234"}).json()["access_token"]
    return email, {"Authorization": f"Bearer {tok}"}


def _pair_code(client: TestClient, headers: dict[str, str], channel: str) -> str:
    r = client.post(f"/v1/channels/{channel}/link-code", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["code"]


class FakeAgent:
    """Replaces run_agent; can stage a pending fact the way a vision handler would."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, stage_fact: bool = False) -> None:
        self.prompts: list[str] = []
        self.conversations: list[str | None] = []
        self.stage_fact = stage_fact
        monkeypatch.setattr("app.ingestion.pipeline.run_agent", self.run)

    async def run(self, session, user_id, text, conversation_id=None, emit=None):
        from app.models import Entity
        from app.services.facts import stage_or_commit_observation

        self.prompts.append(text)
        self.conversations.append(conversation_id)
        if self.stage_fact:
            from sqlalchemy import select

            from app.models import Collection

            col = (await session.execute(select(Collection).where(Collection.user_id == user_id))).scalars().first()
            ent = Entity(user_id=user_id, collection_id=col.id, domain="automotive.vehicle", payload={"make": "Toyota"})
            session.add(ent)
            await session.flush()
            from datetime import datetime, timezone

            await stage_or_commit_observation(
                session, user_id, entity_id=ent.id, kind="service_event",
                occurred_at=datetime.now(timezone.utc), payload={"odometer_km": 100},
                summary="Сервис: пробег 100 км", needs_confirmation=True,
            )
        return {"assistant_text": "Принято.", "raw_last": {}}


# --- Telegram ---------------------------------------------------------------------------------


def _tg_pair(client: TestClient, headers: dict[str, str], tg_id: int) -> None:
    code = _pair_code(client, headers, "telegram")
    client.post(
        "/v1/channels/telegram/webhook",
        json={"message": {"from": {"id": tg_id}, "chat": {"id": tg_id}, "text": f"/start {code}"}},
    )


def test_telegram_pdf_document_becomes_attachment(client: TestClient, monkeypatch) -> None:
    _, h = _user(client)
    tg = 880000 + uuid.uuid4().int % 9999
    _tg_pair(client, h, tg)
    agent = FakeAgent(monkeypatch)
    sent: list[str] = []

    async def fake_send(chat_id, text, **kw):
        sent.append(text)

    async def fake_dl(file_id, mime_hint=None):
        assert file_id == "doc-1"
        return b"%PDF-1.4 fake", mime_hint or "application/pdf"

    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    monkeypatch.setattr(telegram_mod, "_download_tg_file", fake_dl)
    r = client.post(
        "/v1/channels/telegram/webhook",
        json={"message": {"message_id": 5, "from": {"id": tg}, "chat": {"id": tg}, "caption": "анализы",
                          "document": {"file_id": "doc-1", "file_name": "cbc.pdf", "mime_type": "application/pdf"}}},
    )
    assert r.status_code == 200
    assert "[pdf document filename=cbc.pdf" in agent.prompts[-1] and "анализы" in agent.prompts[-1]
    assert sent[-1] == "Принято."


def test_telegram_oversized_file_is_refused(client: TestClient, monkeypatch) -> None:
    _, h = _user(client)
    tg = 870000 + uuid.uuid4().int % 9999
    _tg_pair(client, h, tg)
    agent = FakeAgent(monkeypatch)
    monkeypatch.setattr(get_settings(), "max_upload_bytes", 10)
    sent: list[str] = []

    async def fake_send(chat_id, text, **kw):
        sent.append(text)

    async def fake_dl(file_id, mime_hint=None):
        return b"x" * 100, "application/pdf"

    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    monkeypatch.setattr(telegram_mod, "_download_tg_file", fake_dl)
    client.post(
        "/v1/channels/telegram/webhook",
        json={"message": {"message_id": 6, "from": {"id": tg}, "chat": {"id": tg},
                          "document": {"file_id": "big", "file_name": "big.pdf"}}},
    )
    assert agent.prompts == [] and "большой" in sent[-1].lower()


def test_telegram_fact_confirmation_buttons(client: TestClient, monkeypatch) -> None:
    _, h = _user(client)
    tg = 860000 + uuid.uuid4().int % 9999
    _tg_pair(client, h, tg)
    FakeAgent(monkeypatch, stage_fact=True)
    sent: list[dict[str, Any]] = []
    api_calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_send(chat_id, text, reply_markup=None):
        sent.append({"text": text, "markup": reply_markup})

    async def fake_api(method, payload):
        api_calls.append((method, payload))

    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    monkeypatch.setattr(telegram_mod, "_tg_api", fake_api)
    r = client.post("/v1/channels/telegram/webhook",
                    json={"message": {"message_id": 7, "from": {"id": tg}, "chat": {"id": tg}, "text": "чек"}})
    assert r.status_code == 200
    prompt = sent[-1]
    assert prompt["markup"] is not None, sent
    buttons = prompt["markup"]["inline_keyboard"][0]
    confirm_data, reject_data = buttons[0]["callback_data"], buttons[1]["callback_data"]
    assert confirm_data.startswith("fact:c:") and reject_data.startswith("fact:r:")
    fact_id = confirm_data.split(":")[2]

    # a job is waiting for the decision, nothing is in the knowledge base yet
    facts = client.get("/v1/facts?status=pending_user_confirm", headers=h).json()["facts"]
    assert [f["id"] for f in facts] == [fact_id]

    # another Telegram account cannot press our button
    client.post("/v1/channels/telegram/webhook", json={"callback_query": {
        "id": "x", "from": {"id": 1}, "data": confirm_data,
        "message": {"chat": {"id": 1}, "message_id": 1}}})
    assert client.get("/v1/facts?status=pending_user_confirm", headers=h).json()["facts"]

    r = client.post("/v1/channels/telegram/webhook", json={"callback_query": {
        "id": "cb1", "from": {"id": tg}, "data": confirm_data,
        "message": {"chat": {"id": tg}, "message_id": 99}}})
    assert r.status_code == 200
    methods = [m for m, _ in api_calls]
    assert "answerCallbackQuery" in methods and "editMessageText" in methods
    assert client.get("/v1/facts?status=committed", headers=h).json()["facts"][0]["id"] == fact_id
    # pressing twice is harmless
    client.post("/v1/channels/telegram/webhook", json={"callback_query": {
        "id": "cb2", "from": {"id": tg}, "data": confirm_data,
        "message": {"chat": {"id": tg}, "message_id": 99}}})
    assert len(client.get("/v1/facts?status=committed", headers=h).json()["facts"]) == 1


def test_telegram_webhook_retry_is_deduplicated_and_commands(client: TestClient, monkeypatch) -> None:
    _, h = _user(client)
    tg = 850000 + uuid.uuid4().int % 9999
    _tg_pair(client, h, tg)
    agent = FakeAgent(monkeypatch)
    sent: list[str] = []

    async def fake_send(chat_id, text, **kw):
        sent.append(text)

    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    upd = {"message": {"message_id": 11, "from": {"id": tg}, "chat": {"id": tg}, "text": "привет"}}
    client.post("/v1/channels/telegram/webhook", json=upd)
    client.post("/v1/channels/telegram/webhook", json=upd)  # Telegram retry
    assert len(agent.prompts) == 1

    first_conv = agent.conversations[-1]
    client.post("/v1/channels/telegram/webhook",
                json={"message": {"message_id": 12, "from": {"id": tg}, "chat": {"id": tg}, "text": "/new"}})
    client.post("/v1/channels/telegram/webhook",
                json={"message": {"message_id": 13, "from": {"id": tg}, "chat": {"id": tg}, "text": "снова"}})
    assert agent.conversations[-1] != first_conv, "/new starts a fresh conversation"
    client.post("/v1/channels/telegram/webhook",
                json={"message": {"message_id": 14, "from": {"id": tg}, "chat": {"id": tg}, "text": "/stop"}})
    assert sent[-1] == "Нет активных задач."


def test_telegram_agent_crash_answers_user_without_500(client: TestClient, monkeypatch) -> None:
    _, h = _user(client)
    tg = 840000 + uuid.uuid4().int % 9999
    _tg_pair(client, h, tg)
    sent: list[str] = []

    async def boom(session, user_id, text, conversation_id=None, emit=None):
        raise RuntimeError("llm down")

    async def fake_send(chat_id, text, **kw):
        sent.append(text)

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", boom)
    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    r = client.post("/v1/channels/telegram/webhook",
                    json={"message": {"message_id": 21, "from": {"id": tg}, "chat": {"id": tg}, "text": "hi"}})
    assert r.status_code == 200 and "llm down" in sent[-1]


# --- Slack --------------------------------------------------------------------------------------

SLACK_SECRET = "slack-secret-for-tests"


def _slack_headers(body: bytes, content_type: str = "application/json") -> dict[str, str]:
    ts = str(int(time.time()))
    sig = hmac.new(SLACK_SECRET.encode(), b"v0:" + ts.encode() + b":" + body, hashlib.sha256).hexdigest()
    return {"X-Slack-Signature": f"v0={sig}", "X-Slack-Request-Timestamp": ts, "Content-Type": content_type}


def _slack_post(client: TestClient, payload: dict[str, Any], extra: dict[str, str] | None = None):
    body = json.dumps(payload).encode()
    return client.post("/v1/channels/slack/events", content=body, headers={**_slack_headers(body), **(extra or {})})


@pytest.fixture
def slack_env(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "slack_signing_secret", SLACK_SECRET)
    monkeypatch.setattr(s, "slack_bot_token", "xoxb-test")
    return s


def test_slack_threads_files_bots_and_retries(client: TestClient, monkeypatch, slack_env) -> None:
    _, h = _user(client)
    su = "U" + uuid.uuid4().hex[:8].upper()
    code = _pair_code(client, h, "slack")
    posted: list[tuple[str, str, str | None]] = []

    async def fake_send(channel, text, thread_ts=None, blocks=None):
        posted.append((channel, text, thread_ts))

    async def fake_file(file):
        assert file["url_private_download"].startswith("https://files.slack.com")
        return b"%PDF fake"

    monkeypatch.setattr(slack_mod, "send_slack_message", fake_send)
    monkeypatch.setattr(slack_mod, "_download_slack_file", fake_file)
    agent = FakeAgent(monkeypatch)

    _slack_post(client, {"type": "event_callback", "event": {"type": "message", "user": su, "channel": "D1",
                                                            "text": f"/start {code}", "ts": "1.0"}})
    assert "привязан" in posted[-1][1]

    # file in a channel thread: answered inside the thread, PDF reaches the agent
    ev = {"type": "event_callback", "event_id": "E1", "event": {
        "type": "message", "subtype": "file_share", "user": su, "channel": "C9", "channel_type": "channel",
        "text": "<@UBOT> вот отчёт", "ts": "100.5", "thread_ts": "100.1",
        "files": [{"name": "r.pdf", "mimetype": "application/pdf", "size": 10,
                   "url_private_download": "https://files.slack.com/r.pdf"}]}}
    assert _slack_post(client, ev).status_code == 200
    assert "[pdf document filename=r.pdf" in agent.prompts[-1] and "<@UBOT>" not in agent.prompts[-1]
    assert posted[-1] == ("C9", "Принято.", "100.1")

    n = len(agent.prompts)
    _slack_post(client, ev)  # same message again (e.g. app_mention + message)
    assert len(agent.prompts) == n
    # Slack retry header and bot messages are ignored
    ev2 = {"type": "event_callback", "event": {"type": "message", "user": su, "channel": "D2", "text": "x", "ts": "9.9"}}
    _slack_post(client, ev2, {"X-Slack-Retry-Num": "1"})
    _slack_post(client, {"type": "event_callback", "event": {"type": "message", "bot_id": "B1", "user": su,
                                                             "channel": "D2", "text": "x", "ts": "9.8"}})
    assert len(agent.prompts) == n
    # different threads = different conversations
    _slack_post(client, {"type": "event_callback", "event": {"type": "message", "user": su, "channel": "C9",
                                                            "text": "t2", "ts": "200.2", "thread_ts": "200.0"}})
    assert agent.conversations[-1] != agent.conversations[-2]


def test_slack_interactive_confirm(client: TestClient, monkeypatch, slack_env) -> None:
    _, h = _user(client)
    su = "U" + uuid.uuid4().hex[:8].upper()
    code = _pair_code(client, h, "slack")
    blocks_seen: list[Any] = []

    async def fake_send(channel, text, thread_ts=None, blocks=None):
        blocks_seen.append(blocks)

    responses: list[dict[str, Any]] = []

    async def fake_request_json(method, url, **kw):
        responses.append({"url": url, **kw.get("json", {})})

        class R:
            content = b""

        return R()

    monkeypatch.setattr(slack_mod, "send_slack_message", fake_send)
    monkeypatch.setattr(slack_mod, "request_json", fake_request_json)
    FakeAgent(monkeypatch, stage_fact=True)
    _slack_post(client, {"type": "event_callback", "event": {"type": "message", "user": su, "channel": "D1",
                                                            "text": f"/start {code}", "ts": "1.0"}})
    _slack_post(client, {"type": "event_callback", "event": {"type": "message", "user": su, "channel": "D1",
                                                            "text": "чек", "ts": "2.0"}})
    block = next(b for b in blocks_seen if b)
    value = block[1]["elements"][0]["value"]
    payload = {"type": "block_actions", "user": {"id": su}, "response_url": "https://hooks.slack.test/r",
               "actions": [{"action_id": "fact_confirm", "value": value}]}
    body = urlencode({"payload": json.dumps(payload)}).encode()
    r = client.post("/v1/channels/slack/interactive", content=body,
                    headers=_slack_headers(body, "application/x-www-form-urlencoded"))
    assert r.status_code == 200
    assert client.get("/v1/facts?status=committed", headers=h).json()["facts"][0]["id"] == value
    assert responses and responses[-1]["replace_original"] is True


# --- WhatsApp -----------------------------------------------------------------------------------


def _wa_post(client: TestClient, payload: dict[str, Any], secret: str = "wa-secret"):
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return client.post("/v1/channels/whatsapp/webhook", content=body,
                       headers={"X-Hub-Signature-256": sig, "Content-Type": "application/json"})


def _wa_msg(wa_id: str, **message: Any) -> dict[str, Any]:
    return {"entry": [{"changes": [{"value": {"messages": [{"from": wa_id, **message}]}}]}]}


def test_whatsapp_verify_signature_link_media_and_buttons(client: TestClient, monkeypatch) -> None:
    s = get_settings()
    monkeypatch.setattr(s, "whatsapp_app_secret", "wa-secret")
    monkeypatch.setattr(s, "whatsapp_verify_token", "verify-me")

    ok = client.get("/v1/channels/whatsapp/webhook",
                    params={"hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "1234"})
    assert ok.status_code == 200 and ok.text == "1234"
    assert client.get("/v1/channels/whatsapp/webhook",
                      params={"hub.mode": "subscribe", "hub.verify_token": "bad", "hub.challenge": "1"}).status_code == 403

    assert client.post("/v1/channels/whatsapp/webhook", json={},
                       headers={"X-Hub-Signature-256": "sha256=00"}).status_code == 401

    _, h = _user(client)
    wa = "7" + str(uuid.uuid4().int)[:10]
    code = _pair_code(client, h, "whatsapp")
    texts: list[str] = []
    payloads: list[dict[str, Any]] = []

    async def fake_post(to, payload):
        payloads.append(payload)
        if payload.get("type") == "text":
            texts.append(payload["text"]["body"])

    async def fake_media(media_id):
        return b"%PDF fake", "application/pdf"

    monkeypatch.setattr(wa_mod, "_post_message", fake_post)
    monkeypatch.setattr(wa_mod, "_download_media", fake_media)
    agent = FakeAgent(monkeypatch, stage_fact=True)

    _wa_post(client, _wa_msg(wa, id="m0", type="text", text={"body": f"/start {code}"}))
    assert "привязан" in texts[-1]
    _wa_post(client, _wa_msg(wa, id="m1", type="document",
                             document={"id": "media1", "filename": "lab.pdf", "mime_type": "application/pdf",
                                       "caption": "вот"}))
    assert "[pdf document filename=lab.pdf" in agent.prompts[-1]
    interactive = next(p for p in payloads if p.get("type") == "interactive")
    btn_id = interactive["interactive"]["action"]["buttons"][0]["reply"]["id"]
    assert btn_id.startswith("fact:c:")
    _wa_post(client, _wa_msg(wa, id="m2", type="interactive",
                             interactive={"button_reply": {"id": btn_id, "title": "ok"}}))
    assert client.get("/v1/facts?status=committed", headers=h).json()["facts"]
    assert "Сохранено" in texts[-1]
    # duplicate delivery of m1 is ignored
    n = len(agent.prompts)
    _wa_post(client, _wa_msg(wa, id="m1", type="document",
                             document={"id": "media1", "filename": "lab.pdf", "mime_type": "application/pdf"}))
    assert len(agent.prompts) == n


# --- Discord ------------------------------------------------------------------------------------


@pytest.fixture
def discord_key(monkeypatch):
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    s = get_settings()
    monkeypatch.setattr(s, "discord_public_key", pub)
    monkeypatch.setattr(s, "discord_application_id", "app1")
    return priv


def _dc_post(client: TestClient, priv: Ed25519PrivateKey, payload: dict[str, Any], tamper: bool = False):
    body = json.dumps(payload).encode()
    ts = str(int(time.time()))
    sig = priv.sign(ts.encode() + (body + b" " if tamper else body)).hex()
    return client.post("/v1/channels/discord/interactions", content=body,
                       headers={"X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts,
                                "Content-Type": "application/json"})


def test_discord_signature_ping_and_commands(client: TestClient, monkeypatch, discord_key) -> None:
    assert _dc_post(client, discord_key, {"type": 1}).json() == {"type": 1}
    assert _dc_post(client, discord_key, {"type": 1}, tamper=True).status_code == 401
    assert client.post("/v1/channels/discord/interactions", json={"type": 1}).status_code == 401

    _, h = _user(client)
    did = "D" + str(uuid.uuid4().int)[:12]
    code = _pair_code(client, h, "discord")
    member = {"user": {"id": did}}
    r = _dc_post(client, discord_key, {"type": 2, "id": "i0", "member": member, "data": {
        "name": "link", "options": [{"name": "code", "value": code}]}})
    assert "привязан" in r.json()["data"]["content"] and r.json()["data"]["flags"] == 64
    stranger = _dc_post(client, discord_key, {"type": 2, "id": "i1", "member": {"user": {"id": "nobody"}},
                                              "data": {"name": "ask", "options": [{"name": "text", "value": "hi"}]}})
    assert "привяжите" in stranger.json()["data"]["content"]

    edits: list[tuple[str, str, dict[str, Any]]] = []

    async def fake_request(method, url, **kw):
        edits.append((method, url, kw.get("json") or {}))

        class R:
            content = b"%PDF fake"

            def json(self):
                return {}

        return R()

    monkeypatch.setattr(discord_mod, "request_json", fake_request)
    monkeypatch.setattr(discord_mod, "store_blob", discord_mod.store_blob)
    agent = FakeAgent(monkeypatch, stage_fact=True)
    inter = {"type": 2, "id": "i2", "token": "tok", "application_id": "app1", "channel_id": "ch1", "member": member,
             "data": {"name": "ask", "options": [{"name": "text", "value": "чек"}, {"name": "file", "value": "a1"}],
                      "resolved": {"attachments": {"a1": {
                          "url": "https://cdn.discordapp.com/x.pdf", "filename": "x.pdf",
                          "content_type": "application/pdf", "size": 20}}}}}
    r = _dc_post(client, discord_key, inter)
    assert r.json() == {"type": 5}  # deferred within Discord's 3 s budget
    assert "[pdf document filename=x.pdf" in agent.prompts[-1]
    methods = [(m, u) for m, u, _ in edits]
    assert ("PATCH", "https://discord.com/api/v10/webhooks/app1/tok/messages/@original") in methods
    assert ("POST", "https://discord.com/api/v10/webhooks/app1/tok") in methods  # the confirmation prompt
    prompt = next(p for m, u, p in edits if "components" in p)
    custom_id = prompt["components"][0]["components"][0]["custom_id"]
    assert custom_id.startswith("fact:c:")

    r = _dc_post(client, discord_key, {"type": 3, "id": "i3", "member": member, "data": {"custom_id": custom_id}})
    assert r.json()["type"] == 7 and "Сохранено" in r.json()["data"]["content"]
    assert client.get("/v1/facts?status=committed", headers=h).json()["facts"]

    n = len(agent.prompts)
    _dc_post(client, discord_key, {**inter, "id": "i2"})  # redelivery of the same interaction
    assert len(agent.prompts) == n


def test_discord_register_commands_are_valid() -> None:
    from app.channels.discord_register import COMMANDS

    assert {c["name"] for c in COMMANDS} == {"ask", "link", "stop", "new"}
    ask = next(c for c in COMMANDS if c["name"] == "ask")
    assert any(o["type"] == 11 for o in ask["options"])  # attachment option


def test_signature_helpers_reject_garbage() -> None:
    assert not discord_mod.verify_signature("zz", "zz", "1", b"")
    assert not wa_mod.verify_signature(b"{}", None, "s")
    assert wa_mod.verify_signature(b"{}", "sha256=" + hmac.new(b"s", b"{}", hashlib.sha256).hexdigest(), "s")
    _ = base64
