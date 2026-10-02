from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from jose import JWTError, jwt
from jose.exceptions import JWTClaimsError

from app.config import get_settings

# Versioned prehashing keeps bcrypt input below 72 bytes without losing password suffixes.
_PASSWORD_PREFIX = "$pia-bcrypt-sha256$"


def _password_input(password: str) -> bytes:
    return base64.b64encode(hashlib.sha256(password.encode("utf-8")).digest())


def hash_password(password: str) -> str:
    return _PASSWORD_PREFIX + bcrypt.hashpw(_password_input(password), bcrypt.gensalt()).decode("ascii")


def password_needs_rehash(hashed: str) -> bool:
    return not hashed.startswith(_PASSWORD_PREFIX)


def verify_password(password: str, hashed: str) -> bool:
    try:
        if hashed.startswith(_PASSWORD_PREFIX):
            return bcrypt.checkpw(_password_input(password), hashed.removeprefix(_PASSWORD_PREFIX).encode("ascii"))
        # Compatibility with existing accounts. Successful login upgrades this legacy hash.
        return bcrypt.checkpw(password.encode("utf-8")[:72], hashed.encode("ascii"))
    except (ValueError, UnicodeError):
        return False


def _kid(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()[:8]


def _encode(payload: dict[str, Any]) -> str:
    s = get_settings()
    secret = s.jwt_secret
    return jwt.encode(payload, secret, algorithm=s.jwt_algorithm, headers={"kid": _kid(secret)})


def create_access_token(subject: str, token_version: int = 0) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    exp = int((now + timedelta(minutes=s.access_token_expire_minutes)).timestamp())
    return _encode({"sub": subject, "exp": exp, "type": "access", "tv": token_version, "jti": uuid.uuid4().hex})


def create_refresh_token(subject: str, token_version: int = 0) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    exp = int((now + timedelta(days=s.refresh_token_expire_days)).timestamp())
    return _encode({"sub": subject, "exp": exp, "type": "refresh", "tv": token_version, "jti": uuid.uuid4().hex})


def decode_claims(token: str, expected_type: str = "access") -> dict[str, Any] | None:
    """Verify signature with the current secret, then previous ones (rotation window)."""
    s = get_settings()
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        return None
    secrets_ = s.jwt_secrets
    kid = header.get("kid")
    # try the key the token claims first, but still fall back to all (tokens minted before kid existed)
    ordered = sorted(secrets_, key=lambda x: 0 if kid and _kid(x) == kid else 1)
    for secret in ordered:
        try:
            payload = jwt.decode(token, secret, algorithms=[s.jwt_algorithm])
        except (JWTError, JWTClaimsError):
            continue
        if payload.get("type", "access") != expected_type:
            return None
        return payload
    return None


def decode_token(token: str, expected_type: str = "access") -> str | None:
    payload = decode_claims(token, expected_type)
    if not payload:
        return None
    sub = payload.get("sub")
    return str(sub) if sub else None
