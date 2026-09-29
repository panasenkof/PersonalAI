from __future__ import annotations

import asyncio

from starlette.testclient import TestClient

from app.channels import telegram as telegram_mod
from app.ingestion import pipeline as pipeline_mod


def test_worker_crash_marks_job_failed(monkeypatch) -> None:
    """A crash outside process_envelope must fail the job — not hang SSE forever."""
    import uuid

    from app.db import SessionLocal
    from app.models import IngestionJob, JobStatus, User
    from app.queue.jobs import execute_job

    async def setup() -> str:
        async with SessionLocal() as s:
            u = User(email=f"crash-{uuid.uuid4().hex[:8]}@t.dev", password_hash="x")
            s.add(u)
            await s.flush()
            job = IngestionJob(
                user_id=u.id,
                status=JobStatus.accepted.value,
                # wrong types → IngestionEnvelope validation blows up in the worker
                envelope={"text": 123, "attachments": "nope"},
            )
            s.add(job)
            await s.commit()
            return job.id

    job_id = asyncio.run(setup())
    out = asyncio.run(execute_job(job_id))
    assert out.get("failed") is True

    async def check() -> tuple[str, str | None]:
        async with SessionLocal() as s:
            job = await s.get(IngestionJob, job_id)
            return job.status, job.error

    status, error = asyncio.run(check())
    assert status == "failed"
    assert error


def test_telegram_voice_message_gets_transcribed(
    client: TestClient, random_email: str, monkeypatch
) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r = client.post("/v1/channels/telegram/link-code", headers={"Authorization": f"Bearer {token}"})
    code = r.json()["code"]
    client.post(
        "/v1/channels/telegram/webhook",
        json={"message": {"from": {"id": 555001}, "chat": {"id": 555001}, "text": f"/start {code}"}},
    )

    captured: dict[str, str] = {}
    sent: list[str] = []

    async def fake_send(chat_id: int, text: str) -> None:
        sent.append(text)

    async def fake_download(file_id: str) -> tuple[bytes, str]:
        return b"OGGDATA", "audio/ogg"

    class FakeSTT:
        async def transcribe(self, *, storage_key: str, mime: str) -> str:
            assert mime == "audio/ogg"
            return "привет, это голосовое"

    async def fake_run(session, user_id, text, conversation_id=None, emit=None):
        captured["prompt"] = text
        return {"assistant_text": "услышал", "raw_last": {}}

    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    monkeypatch.setattr(telegram_mod, "_download_tg_file", fake_download)
    monkeypatch.setattr(pipeline_mod, "stt_provider_from_settings", lambda: FakeSTT())
    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)

    r = client.post(
        "/v1/channels/telegram/webhook",
        json={
            "message": {
                "from": {"id": 555001},
                "chat": {"id": 555001},
                "message_id": 9,
                "voice": {"file_id": "voice-file"},
            }
        },
    )
    assert r.status_code == 200 and r.json()["ok"] == "true"
    assert "[audio transcript] привет, это голосовое" in captured["prompt"]
    assert sent and sent[-1] == "услышал"


def test_whisper_stt_provider_uploads_audio(monkeypatch) -> None:
    import httpx

    from app.ingestion.stt import WhisperApiSTTProvider

    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        body = request.content
        seen["has_audio"] = b"OGGDATA" in body
        seen["model_in_body"] = b"whisper-1" in body
        return httpx.Response(200, json={"text": "  расшифровка  "})

    real_client = httpx.AsyncClient

    def fake_client(**kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(**kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", fake_client)

    async def fake_read(key: str) -> bytes:
        return b"OGGDATA"

    import app.storage.blob as blob_mod

    monkeypatch.setattr(blob_mod, "read_bytes", fake_read)

    prov = WhisperApiSTTProvider("https://api.example.com/v1", "sk-test")
    text = asyncio.run(prov.transcribe(storage_key="aa/bb/x.ogg", mime="audio/ogg"))
    assert text == "расшифровка"
    assert seen["url"].endswith("/v1/audio/transcriptions")
    assert seen["has_audio"] and seen["model_in_body"]


def test_stt_provider_from_settings(monkeypatch) -> None:
    from app import config
    from app.ingestion.stt import StubSTTProvider, WhisperApiSTTProvider, stt_provider_from_settings

    monkeypatch.setenv("STT_BASE_URL", "")
    config.get_settings.cache_clear()
    try:
        assert isinstance(stt_provider_from_settings(), StubSTTProvider)

        monkeypatch.setenv("STT_BASE_URL", "https://whisper.local/v1")
        config.get_settings.cache_clear()
        prov = stt_provider_from_settings()
        assert isinstance(prov, WhisperApiSTTProvider)
        assert prov.base_url == "https://whisper.local/v1"
    finally:
        config.get_settings.cache_clear()


def test_delete_conversation(client: TestClient, random_email: str, monkeypatch) -> None:
    async def fake_run(session, user_id, text, conversation_id=None, emit=None):
        return {"assistant_text": "ок", "raw_last": {}}

    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    r2 = client.post("/v1/messages", json={"text": "привет"}, headers=headers)
    conv_id = r2.json()["conversation_id"]

    # turns exist before delete
    r3 = client.get(f"/v1/conversations/{conv_id}/messages", headers=headers)
    assert len(r3.json()) == 2

    r4 = client.delete(f"/v1/conversations/{conv_id}", headers=headers)
    assert r4.status_code == 200 and r4.json()["status"] == "deleted"

    r5 = client.get(f"/v1/conversations/{conv_id}/messages", headers=headers)
    assert r5.status_code == 404
    r6 = client.get("/v1/conversations", headers=headers)
    assert all(c["id"] != conv_id for c in r6.json())

    # deleting someone else's conversation → 404 (not 403: no existence leak)
    r7 = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    if r7.status_code == 200:
        other_headers = {"Authorization": f"Bearer {r7.json()['access_token']}"}
        r8 = client.delete(f"/v1/conversations/{conv_id}", headers=other_headers)
        assert r8.status_code == 404
