from __future__ import annotations

import asyncio

import pytest
from starlette.testclient import TestClient

from app.config import Settings
from app.llm.router import local_fallback_target
from app.storage.blob import InvalidStorageKey, read_bytes, resolve_storage_path


def test_path_traversal_rejected(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BLOB_STORAGE_DIR", str(tmp_path))
    from app import config

    config.get_settings.cache_clear()
    try:
        with pytest.raises(InvalidStorageKey):
            resolve_storage_path("../../../etc/passwd")
        with pytest.raises(InvalidStorageKey):
            resolve_storage_path("../secret")
        with pytest.raises(InvalidStorageKey):
            resolve_storage_path("aa/../../evil")
        # normal key resolves inside the root
        (tmp_path / "aa").mkdir()
        (tmp_path / "aa" / "f.bin").write_bytes(b"x")
        assert asyncio.run(read_bytes("aa/f.bin")) == b"x"
    finally:
        config.get_settings.cache_clear()


def test_long_password_register_and_login(client: TestClient, random_email: str) -> None:
    # bcrypt truncates at 72 bytes; registration must not blow up on longer secrets
    long_pw = "A" * 100 + "!"
    r = client.post("/v1/auth/register", json={"email": random_email, "password": long_pw})
    assert r.status_code == 200
    r2 = client.post("/v1/auth/token", json={"email": random_email, "password": long_pw})
    assert r2.status_code == 200


def test_message_with_foreign_storage_key_rejected(
    client: TestClient, random_email: str
) -> None:
    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]
    r2 = client.post(
        "/v1/messages",
        json={
            "text": "привет",
            "attachments": [{"mime": "image/png", "storage_key": "aa/bb/notmine.png"}],
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 422
    assert r2.json()["detail"] == "unknown_storage_key"


def test_upload_size_limit(
    client: TestClient, random_email: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.v1 import messages as messages_mod

    r = client.post("/v1/auth/register", json={"email": random_email, "password": "secret1234"})
    token = r.json()["access_token"]

    class _S:
        max_upload_bytes = 16

    monkeypatch.setattr(messages_mod, "get_settings", lambda: _S())
    big = b"0" * 64
    r2 = client.post(
        "/v1/blobs",
        files={"file": ("big.bin", big, "application/octet-stream")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r2.status_code == 413


def test_local_fallback_target_enabled_and_disabled() -> None:
    off = Settings(llm_allow_local_fallback=False, fallback_base_url="https://x/v1")
    assert local_fallback_target(off) is None
    no_url = Settings(llm_allow_local_fallback=True, fallback_base_url="")
    assert local_fallback_target(no_url) is None
    on = Settings(
        llm_allow_local_fallback=True,
        fallback_base_url="https://fallback.example/v1",
        fallback_api_key="k",
        fallback_model="m1",
    )
    target = local_fallback_target(on)
    assert target is not None
    provider, model = target
    assert model == "m1"
    assert provider.base_url == "https://fallback.example/v1"
