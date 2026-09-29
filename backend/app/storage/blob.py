from __future__ import annotations

import hashlib
import os
import uuid

from app.config import get_settings


class InvalidStorageKey(ValueError):
    """Raised when a storage_key escapes the blob storage root."""


def resolve_storage_path(storage_key: str) -> str:
    """Resolve storage_key inside the blob dir, rejecting path traversal."""
    base = os.path.abspath(get_settings().blob_storage_dir)
    path = os.path.abspath(os.path.join(base, storage_key))
    if path != base and not path.startswith(base + os.sep):
        raise InvalidStorageKey(storage_key)
    return path


def save_bytes(data: bytes, mime: str) -> tuple[str, str, int]:
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
    elif "mpeg" in mime or "mp3" in mime or "ogg" in mime or "opus" in mime:
        ext = ".oga"
    elif "text" in mime:
        ext = ".txt"
    key = f"{sha[:2]}/{sha[2:4]}/{uuid.uuid4().hex}{ext}"
    path = resolve_storage_path(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return key, sha, len(data)


async def read_bytes(storage_key: str) -> bytes:
    path = resolve_storage_path(storage_key)
    with open(path, "rb") as f:
        return f.read()


def file_url_for_model(storage_key: str) -> str:
    """Not a public URL in MVP; vision uses base64 from disk."""
    _ = storage_key
    return ""
