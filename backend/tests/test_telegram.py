from __future__ import annotations

import re

from starlette.testclient import TestClient

from app.channels import telegram as telegram_mod


def test_telegram_photo_flow_records_blob_and_replies(
    client: TestClient, random_email: str, monkeypatch
) -> None:
    # 1) register + issue link code
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r = client.post(
        "/v1/channels/telegram/link-code", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200
    code = r.json()["code"]

    # 2) pair account via /start CODE
    r = client.post(
        "/v1/channels/telegram/webhook",
        json={"message": {"from": {"id": 777001}, "chat": {"id": 777001}, "text": f"/start {code}"}},
    )
    assert r.status_code == 200 and r.json()["ok"] == "true"

    # 3) stub external services
    sent: list[tuple[int, str]] = []
    captured: dict[str, str] = {}

    async def fake_send(chat_id: int, text: str) -> None:
        sent.append((chat_id, text))

    async def fake_download(file_id: str) -> tuple[bytes, str]:
        assert file_id == "photo-file-id"
        return b"\x89PNG fake", "image/png"

    async def fake_run(session, user_id: str, user_visible_text: str, conversation_id=None, emit=None):
        captured["prompt"] = user_visible_text
        return {"assistant_text": "Фото получил.", "raw_last": {}}

    monkeypatch.setattr(telegram_mod, "send_telegram_message", fake_send)
    monkeypatch.setattr(telegram_mod, "_download_tg_file", fake_download)
    monkeypatch.setattr("app.ingestion.pipeline.run_agent", fake_run)

    # 4) send a photo — this used to crash with NameError on save_bytes
    r = client.post(
        "/v1/channels/telegram/webhook",
        json={
            "message": {
                "from": {"id": 777001},
                "chat": {"id": 777001},
                "message_id": 42,
                "photo": [{"file_id": "photo-file-id"}],
            }
        },
    )
    assert r.status_code == 200 and r.json()["ok"] == "true"
    assert sent and sent[-1] == (777001, "Фото получил.")

    # 5) blob was recorded with ownership: a follow-up message referencing the
    #    same storage_key must pass the ownership check (200, not 422)
    m = re.search(r"storage_key=(\S+?)\s", captured["prompt"] + " ")
    assert m, f"no storage_key in prompt: {captured['prompt']}"
    key = m.group(1)
    r = client.post(
        "/v1/messages",
        json={
            "text": "что на чеке?",
            "attachments": [{"mime": "image/png", "storage_key": key}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text


def test_webhook_rejects_bad_secret(client: TestClient, monkeypatch) -> None:
    class _S:
        telegram_webhook_secret = "s3cret"

    monkeypatch.setattr(telegram_mod, "get_settings", lambda: _S())
    r = client.post("/v1/channels/telegram/webhook", json={"message": {}})
    assert r.status_code == 401
    r2 = client.post(
        "/v1/channels/telegram/webhook",
        json={"message": {}},
        headers={"X-Telegram-Bot-Api-Secret-Token": "s3cret"},
    )
    assert r2.status_code == 200
