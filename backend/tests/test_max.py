from __future__ import annotations

import uuid

import httpx
import pytest

from app.channels import max as m
from app.channels.dispatch import send_reply
from app.config import get_settings
from app.ingestion.schemas import Channel, IngestionEnvelope
from tests.test_channels_full import FakeAgent, _pair_code, _user


def update(uid, text="Привет", mid=None, attachments=None):
    return {
        "update_type": "message_created",
        "message": {
            "sender": {"user_id": uid},
            "recipient": {"chat_type": "dialog", "chat_id": uid + 10},
            "body": {"mid": mid or uuid.uuid4().hex, "text": text, "attachments": attachments or []},
        },
    }


@pytest.fixture
def linked(client, monkeypatch):
    calls = []

    async def send(user_id, text, attachments=None):
        calls.append((user_id, text, attachments))

    monkeypatch.setattr(m, "send_max_message", send)
    monkeypatch.setattr(get_settings(), "message_mode", "sync")
    monkeypatch.setattr(get_settings(), "max_webhook_secret", "")
    _, headers = _user(client)
    uid = int(uuid.uuid4().hex[:10], 16)
    code = _pair_code(client, headers, "max")
    assert client.post("/v1/channels/max/webhook", json=update(uid, f"/start {code}")).status_code == 200
    assert client.get("/v1/auth/me", headers=headers).json()["channels"]["max"]
    calls.clear()
    return uid, headers, calls


def test_secret_and_auth(client, monkeypatch):
    assert client.post("/v1/channels/max/link-code").status_code == 401
    s = get_settings()
    monkeypatch.setattr(s, "max_webhook_secret", "secret")
    assert client.post("/v1/channels/max/webhook", json={}).status_code == 401
    assert (
        client.post("/v1/channels/max/webhook", json={}, headers={"X-Max-Bot-Api-Secret": "secret"}).status_code == 200
    )
    monkeypatch.setattr(s, "max_webhook_secret", "")
    monkeypatch.setattr(s, "app_env", "production")
    assert client.post("/v1/channels/max/webhook", json={}).status_code == 503


def test_text_dedup_commands(client, monkeypatch, linked):
    uid, _, calls = linked
    agent = FakeAgent(monkeypatch)
    upd = update(uid)
    for _ in range(2):
        assert client.post("/v1/channels/max/webhook", json=upd).status_code == 200
    assert agent.prompts == ["Привет"]
    assert calls[0][:2] == (uid, "Принято.")
    client.post("/v1/channels/max/webhook", json=update(uid, "Ещё"))
    assert agent.conversations[0] == agent.conversations[1]
    client.post("/v1/channels/max/webhook", json=update(uid, "/new"))
    client.post("/v1/channels/max/webhook", json=update(uid, "Новый"))
    assert agent.conversations[-1] != agent.conversations[0]
    client.post("/v1/channels/max/webhook", json=update(uid, "/stop"))
    assert calls[-1][1] == "Нет активных задач."


def test_groups_and_unlinked(client, monkeypatch, linked):
    uid, _, calls = linked
    agent = FakeAgent(monkeypatch)
    upd = update(uid)
    upd["message"]["recipient"]["chat_type"] = "chat"
    client.post("/v1/channels/max/webhook", json=upd)
    assert not agent.prompts and not calls
    client.post("/v1/channels/max/webhook", json=update(uid + 1))
    assert "/start" in calls[-1][1]


@pytest.mark.parametrize(
    "kind,mime,name",
    [("image", "image/jpeg", "photo.jpg"), ("file", "text/plain", "note.txt"), ("audio", "audio/ogg", "voice.ogg")],
)
def test_attachments(client, monkeypatch, linked, kind, mime, name):
    uid, _, calls = linked
    FakeAgent(monkeypatch)

    async def download(url):
        return b"example content", mime

    monkeypatch.setattr(m, "_download_media", download)
    assert (
        client.post(
            "/v1/channels/max/webhook",
            json=update(
                uid, attachments=[{"type": kind, "filename": name, "payload": {"url": "https://cdn.max.ru/a"}}]
            ),
        ).status_code
        == 200
    )
    assert calls[0][1] == "Принято."
    import asyncio

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Blob

    async def check():
        async with SessionLocal() as session:
            blobs = (await session.execute(select(Blob).where(Blob.filename == name))).scalars().all()
            assert any(b.mime == mime for b in blobs)

    asyncio.run(check())


def test_size_and_failure(client, monkeypatch, linked):
    uid, _, calls = linked

    async def download(url):
        raise m.MediaTooLarge()

    monkeypatch.setattr(m, "_download_media", download)
    client.post(
        "/v1/channels/max/webhook",
        json=update(uid, attachments=[{"type": "file", "payload": {"url": "https://cdn.max.ru/a"}}]),
    )
    assert calls[-1][1] == "Файл слишком большой."

    async def crash(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(m, "submit_envelope", crash)
    assert client.post("/v1/channels/max/webhook", json=update(uid)).status_code == 200
    assert calls[-1][1].startswith("Ошибка:")


def test_fact_ownership_and_repeat(client, monkeypatch, linked):
    uid, _, calls = linked
    FakeAgent(monkeypatch, stage_fact=True)
    client.post("/v1/channels/max/webhook", json=update(uid))
    payload = calls[-1][2][0]["payload"]["buttons"][0][0]["payload"]
    sent = []

    async def api(path, body, **params):
        sent.append(body)

    monkeypatch.setattr(m, "_max_api", api)
    cb = {
        "update_type": "message_callback",
        "callback": {"user": {"user_id": uid + 1}, "callback_id": "cb", "payload": payload},
    }
    client.post("/v1/channels/max/webhook", json=cb)
    assert sent[-1] == {}
    cb["callback"]["user"]["user_id"] = uid
    client.post("/v1/channels/max/webhook", json=cb)
    assert sent[-1]["message"]["text"].startswith("✅")
    assert sent[-1]["message"]["attachments"] == []
    client.post("/v1/channels/max/webhook", json=cb)
    assert "ранее" in sent[-1]["message"]["text"]


@pytest.mark.asyncio
async def test_dispatch_api_contract(monkeypatch):
    sent = []

    async def request(method, url, **kw):
        sent.append((method, url, kw))
        return httpx.Response(200, json={"message": {}})

    monkeypatch.setattr(m, "request_json", request)
    monkeypatch.setattr(get_settings(), "max_bot_token", "max-secret-token")
    await send_reply(
        IngestionEnvelope(channel=Channel.max, text="x", channel_meta={"user_id": 123}),
        "x" * 4100,
        [{"id": "fact", "summary": "Пробег"}],
    )
    assert len(sent) == 3
    assert sent[0][1] == "https://platform-api2.max.ru/messages"
    assert sent[0][2]["headers"] == {"Authorization": "max-secret-token"}
    assert sent[0][2]["params"] == {"user_id": 123}
    assert len(sent[0][2]["json"]["text"]) == 4000
    assert sent[-1][2]["json"]["attachments"][0]["type"] == "inline_keyboard"


@pytest.mark.parametrize(
    "url",
    [
        "http://cdn.max.ru/a",
        "https://127.0.0.1/a",
        "https://max.ru.evil.com/a",
        "https://user:pass@max.ru/a",
        "https://max.ru:8000/a",
    ],
)
def test_unsafe_media_urls(url):
    with pytest.raises(ValueError):
        m._media_url(url)


def test_deeplink_code_once(client, monkeypatch, linked):
    uid, _, calls = linked
    _, headers = _user(client)
    code = _pair_code(client, headers, "max")
    event = {"update_type": "bot_started", "user": {"user_id": uid + 5}, "chat_id": uid + 10, "payload": code}
    assert client.post("/v1/channels/max/webhook", json=event).status_code == 200
    assert client.get("/v1/auth/me", headers=headers).json()["channels"]["max"]
    event["user"]["user_id"] = uid + 6
    client.post("/v1/channels/max/webhook", json=event)
    assert "недействителен" in calls[-1][1]


def test_queue_webhook_persists_and_deduplicates(client, monkeypatch, linked):
    uid, _, calls = linked
    monkeypatch.setattr(get_settings(), "message_mode", "queue")
    queued = []

    class Runner:
        async def enqueue(self, job_id):
            queued.append(job_id)

    monkeypatch.setattr("app.queue.runner.get_runner", lambda: Runner())
    upd = update(uid, "В очередь")
    for _ in range(2):
        assert client.post("/v1/channels/max/webhook", json=upd).status_code == 200
    assert len(queued) == 1
    assert not calls


@pytest.mark.asyncio
async def test_register_subscription_contract(monkeypatch):
    from app.channels.max_register import register

    s = get_settings()
    monkeypatch.setattr(s, "max_bot_token", "token")
    monkeypatch.setattr(s, "max_webhook_secret", "secret")
    calls = []

    async def request(method, url, **kw):
        calls.append((method, url, kw))
        return httpx.Response(200, json={"success": True})

    monkeypatch.setattr("app.channels.max_register.request_json", request)
    await register("https://example.com/v1/channels/max/webhook")
    assert calls[0][1].endswith("/subscriptions")
    assert calls[0][2]["json"]["update_types"] == ["message_created", "message_callback", "bot_started"]
    assert calls[0][2]["json"]["secret"] == "secret"
    with pytest.raises(ValueError):
        await register("http://example.com/webhook")


@pytest.mark.asyncio
async def test_stream_size_bound_and_redirect(monkeypatch):
    real_client = httpx.AsyncClient

    async def handler(request):
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"location": "https://127.0.0.1/"})
        return httpx.Response(200, content=b"x" * 11)

    monkeypatch.setattr(m.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(get_settings(), "max_upload_bytes", 10)
    with pytest.raises(m.MediaTooLarge):
        await m._download_media("https://cdn.max.ru/file")
    with pytest.raises((ValueError, httpx.HTTPStatusError)):
        await m._download_media("https://cdn.max.ru/redirect")


def test_callback_in_group_does_not_disclose_fact(client, monkeypatch, linked):
    uid, _, calls = linked
    FakeAgent(monkeypatch, stage_fact=True)
    client.post("/v1/channels/max/webhook", json=update(uid))
    data = calls[-1][2][0]["payload"]["buttons"][0][0]["payload"]
    api_calls = []

    async def api(path, body, **params):
        api_calls.append(body)

    monkeypatch.setattr(m, "_max_api", api)
    calls.clear()
    event = {
        "update_type": "message_callback",
        "callback": {"user": {"user_id": uid}, "callback_id": "cb", "payload": data},
        "message": {"recipient": {"chat_type": "chat"}},
    }
    assert client.post("/v1/channels/max/webhook", json=event).status_code == 200
    assert api_calls == [{}] and not calls


def test_max_delivery_retry_does_not_rerun_agent(client, monkeypatch, linked):
    import asyncio
    from datetime import timedelta

    from sqlalchemy import select
    from sqlalchemy import update as sql_update

    from app.db import SessionLocal
    from app.ingestion.schemas import utcnow
    from app.models import ChannelDelivery, IngestionJob
    from app.queue.delivery import deliver_reply

    uid, _, calls = linked
    agent = FakeAgent(monkeypatch)

    async def offline(*args, **kwargs):
        raise ConnectionError("MAX unavailable")

    monkeypatch.setattr(m, "send_max_message", offline)
    event = update(uid, "Сохранить ответ")
    assert client.post("/v1/channels/max/webhook", json=event).status_code == 200
    assert len(agent.prompts) == 1

    async def pending():
        async with SessionLocal() as session:
            job = await session.scalar(
                select(IngestionJob).where(
                    IngestionJob.correlation_id == f"max:{uid}:{event['message']['body']['mid']}"
                )
            )
            row = await session.get(ChannelDelivery, job.id)
            assert row.sent_at is None and row.attempts == 1
            await session.execute(
                sql_update(ChannelDelivery)
                .where(ChannelDelivery.job_id == job.id)
                .values(available_at=utcnow() - timedelta(seconds=1))
            )
            await session.commit()
            return job.id

    job_id = asyncio.run(pending())

    async def online(user_id, text, attachments=None):
        calls.append((user_id, text, attachments))

    monkeypatch.setattr(m, "send_max_message", online)
    assert asyncio.run(deliver_reply(job_id))
    assert not asyncio.run(deliver_reply(job_id))
    assert len(agent.prompts) == 1 and calls[-1][1] == "Принято."
