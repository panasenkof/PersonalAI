from __future__ import annotations

from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from app.config import get_settings

# bcrypt processes at most 72 bytes per the algorithm itself; longer secrets are truncated.
_BCRYPT_MAX_BYTES = 72


def hash_password(password: str) -> str:
    raw = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:_BCRYPT_MAX_BYTES], hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    exp = int((now + timedelta(minutes=s.access_token_expire_minutes)).timestamp())
    payload = {"sub": subject, "exp": exp, "type": "access"}
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def create_refresh_token(subject: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    exp = int((now + timedelta(days=s.refresh_token_expire_days)).timestamp())
    payload = {"sub": subject, "exp": exp, "type": "refresh"}
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_token(token: str, expected_type: str = "access") -> str | None:
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=[get_settings().jwt_algorithm])
        if payload.get("type", "access") != expected_type:
            return None
        sub = payload.get("sub")
        return str(sub) if sub else None
    except JWTError:
        return None
