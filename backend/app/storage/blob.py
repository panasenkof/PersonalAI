from __future__ import annotations

import hashlib
import os
import uuid

from app.config import get_settings


async def save_bytes(data: bytes, mime: str) -> tuple[str, str, int]:
    """Returns storage_key, sha256, size."""
    settings = get_settings()
    os.makedirs(settings.blob_storage_dir, exist_ok=True)
    sha = hashlib.sha256(data).hexdigest()
    ext = ".bin"
    if "png" in mime:
        ext = ".png"
    elif "jpeg" in mime or "jpg" in mime:
        ext = ".jpg"
    elif "webp" in mime:
        ext = ".webp"
    elif "pdf" in mime:
        ext = ".pdf"
    elif "mpeg" in mime or "mp3" in mime:
        ext = ".mp3"
    key = f"{sha[:2]}/{sha[2:4]}/{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.blob_storage_dir, key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return key, sha, len(data)


async def read_bytes(storage_key: str) -> bytes:
    path = os.path.join(get_settings().blob_storage_dir, storage_key)
    with open(path, "rb") as f:
        return f.read()


def file_url_for_model(storage_key: str) -> str:
    """Not a public URL in MVP; vision uses base64 from disk."""
    _ = storage_key
    return ""
