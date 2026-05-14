from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


def _fernet() -> Fernet | None:
    key = get_settings().pia_agent_secret.strip()
    if not key:
        return None
    try:
        return Fernet(key.encode())
    except Exception:
        return None


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
        return None
    try:
        return f.decrypt(ciphertext).decode()
    except InvalidToken:
        return None
