"""RFC 6238 TOTP (SHA-1, 6 digits, 30 s) + one-time recovery codes. Stdlib only."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

STEP_SECONDS = 30
DIGITS = 6


def generate_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    padded = secret.upper() + "=" * (-len(secret) % 8)
    key = base64.b32decode(padded, casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % (10**DIGITS)
    return str(code).zfill(DIGITS)


def totp_at(secret: str, at: float | None = None) -> str:
    return _hotp(secret, int((time.time() if at is None else at) // STEP_SECONDS))


def verify_totp(secret: str, code: str, *, window: int = 1, at: float | None = None) -> bool:
    """Accepts the current step ± `window` steps (clock drift)."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit():
        return False
    step = int((time.time() if at is None else at) // STEP_SECONDS)
    ok = False
    for delta in range(-window, window + 1):
        ok |= hmac.compare_digest(_hotp(secret, step + delta), code)  # no early exit: constant work
    return ok


def match_step(secret: str, code: str, *, window: int = 1, at: float | None = None) -> int | None:
    """Time-step counter that `code` is valid for (current ± window), else None.

    Callers store the returned step and reject any step <= the stored one (RFC 6238 §5.2: an OTP
    must be accepted only once), so a code shoulder-surfed or intercepted cannot be replayed."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit():
        return None
    step = int((time.time() if at is None else at) // STEP_SECONDS)
    found: int | None = None
    for delta in range(-window, window + 1):
        if hmac.compare_digest(_hotp(secret, step + delta), code):
            found = step + delta
    return found


def provisioning_uri(email: str, secret: str, issuer: str = "PIA Agent") -> str:
    return (
        f"otpauth://totp/{quote(issuer)}:{quote(email)}"
        f"?secret={secret}&issuer={quote(issuer)}&digits={DIGITS}&period={STEP_SECONDS}"
    )


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().lower().encode()).hexdigest()


def generate_recovery_codes(n: int = 8) -> tuple[list[str], list[str]]:
    """Returns (plain codes to show once, sha256 hashes to store)."""
    # 64 bits of entropy: the stored hashes are unsalted SHA-256, so the codes must not be brute-forceable
    plain = [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(n)]
    return plain, [_hash_code(c) for c in plain]


def consume_recovery_code(stored_hashes: list[str] | None, code: str) -> list[str] | None:
    """Returns the remaining hashes if `code` matched (and is now spent), else None."""
    if not stored_hashes:
        return None
    h = _hash_code(code)
    for i, existing in enumerate(stored_hashes):
        if hmac.compare_digest(existing, h):
            return stored_hashes[:i] + stored_hashes[i + 1 :]
    return None
