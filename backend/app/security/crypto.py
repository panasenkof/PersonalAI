"""Field-level encryption at rest (Fernet / MultiFernet with key rotation).

``PIA_AGENT_SECRET`` may hold several comma-separated keys: the first one encrypts, all of
them decrypt — put the new key first to rotate without downtime, then re-encrypt with
``python -m app.security.rekey`` (or lazily as rows are rewritten).

Covers: LLM API keys, conversation history (ChatTurn.content), TOTP secrets, uploaded files.
Knowledge-base payloads/chunks stay searchable and rely on volume/database-level encryption
(see docs/SECURITY.md).
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from sqlalchemy import JSON, Text
from sqlalchemy.types import TypeDecorator

from app.config import get_settings

logger = logging.getLogger(__name__)

_strict_decryption: ContextVar[bool] = ContextVar("strict_decryption", default=False)


@contextmanager
def require_decryption():
    token = _strict_decryption.set(True)
    try:
        yield
    finally:
        _strict_decryption.reset(token)


TEXT_PREFIX = "enc1:"
BLOB_MAGIC = b"PIAENC1\n"


def _fernet() -> MultiFernet | None:
    raw = get_settings().pia_agent_secret.strip()
    if not raw:
        return None
    keys: list[Fernet] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            keys.append(Fernet(part.encode()))
        except Exception:  # noqa: BLE001
            logger.error("PIA_AGENT_SECRET contains an invalid Fernet key; ignoring it")
    return MultiFernet(keys) if keys else None


def encryption_enabled() -> bool:
    return _fernet() is not None


def encrypt_api_key(plain: str | None) -> tuple[bytes | None, str | None]:
    """Returns (ciphertext, plain_dev_fallback). If PIA_AGENT_SECRET unset, stores plaintext in dev column only."""
    if not plain:
        return None, None
    f = _fernet()
    if f is None:
        return None, plain
    return f.encrypt(plain.encode()), None


def decrypt_api_key(ciphertext: bytes | None, plain_fallback: str | None) -> str | None:
    if plain_fallback:
        return plain_fallback
    if not ciphertext:
        return None
    f = _fernet()
    if f is None:
        if _strict_decryption.get():
            raise InvalidToken("encryption key missing")
        return None
    try:
        return f.decrypt(ciphertext).decode()
    except InvalidToken:
        if _strict_decryption.get():
            raise
        return None


def encrypt_text(value: str | None) -> str | None:
    if value is None:
        return None
    f = _fernet()
    if f is None or value.startswith(TEXT_PREFIX):
        return value
    return TEXT_PREFIX + f.encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_text(value: str | None) -> str | None:
    """Transparent: plaintext rows written before encryption was enabled are returned as-is."""
    if value is None or not value.startswith(TEXT_PREFIX):
        return value
    f = _fernet()
    if f is None:
        logger.error("encrypted value found but PIA_AGENT_SECRET is not configured")
        if _strict_decryption.get():
            raise InvalidToken("encryption key missing")
        return "[encrypted: key not configured]"
    try:
        return f.decrypt(value[len(TEXT_PREFIX) :].encode("ascii")).decode("utf-8")
    except InvalidToken:
        logger.error("could not decrypt a stored value (wrong key?)")
        if _strict_decryption.get():
            raise
        return "[encrypted: undecryptable]"


def encrypt_bytes(data: bytes) -> bytes:
    f = _fernet()
    if f is None or not get_settings().encrypt_blobs:
        return data
    return BLOB_MAGIC + f.encrypt(data)


def decrypt_bytes(data: bytes) -> bytes:
    if not data.startswith(BLOB_MAGIC):
        return data
    f = _fernet()
    if f is None:
        raise RuntimeError("blob is encrypted but PIA_AGENT_SECRET is not configured")
    return f.decrypt(data[len(BLOB_MAGIC) :])


class EncryptedText(TypeDecorator):
    """Text column transparently encrypted with the configured Fernet keys."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect):  # noqa: ANN001
        return encrypt_text(value)

    def process_result_value(self, value: str | None, dialect):  # noqa: ANN001
        return decrypt_text(value)


class EncryptedJSON(TypeDecorator):
    """JSON column whose content is encrypted at rest when PIA_AGENT_SECRET is set.

    Stored as ``{"__enc": "enc1:..."}`` inside the ordinary JSON column, so no schema change is needed and
    rows written before encryption was enabled (plain JSON) keep loading. Not queryable in SQL: use it
    for documents that are only ever read whole (job envelopes/results, staged facts).
    """

    impl = JSON
    cache_ok = True

    def process_bind_param(self, value: Any, dialect):  # noqa: ANN001
        if value is None:
            return None
        blob = encrypt_text(json.dumps(value, ensure_ascii=False, default=str))
        if blob is not None and blob.startswith(TEXT_PREFIX):
            return {"__enc": blob}
        return value

    def process_result_value(self, value: Any, dialect):  # noqa: ANN001
        if isinstance(value, dict) and set(value) == {"__enc"}:
            plain = decrypt_text(value["__enc"])
            try:
                return json.loads(plain) if plain is not None else None
            except json.JSONDecodeError:
                logger.error("stored JSON could not be decrypted")
                return {"error": "undecryptable"}
        return value
