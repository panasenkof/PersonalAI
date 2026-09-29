"""Keep secrets out of logs and of error texts that are shown to users.

Tokens travel inside URLs (Telegram: ``/bot<TOKEN>/sendMessage``) and headers, so exception messages and
httpx's own INFO request logs contain them. Everything user-visible or logged goes through ``redact``.
"""

from __future__ import annotations

import logging
import re

from app.config import get_settings

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(bot)\d{6,}:[A-Za-z0-9_-]{20,}"), r"\1<redacted>"),  # Telegram bot token in URL
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1<redacted>"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), "<redacted>"),  # OpenAI-style keys
    (re.compile(r"\bxox[abeprs]-[A-Za-z0-9-]{8,}"), "<redacted>"),  # Slack tokens
    (re.compile(r"(?i)((?:access_token|api_key|token|secret)=)[^&\s\"']+"), r"\1<redacted>"),
    (re.compile(r"(://[^/\s:@]+:)[^@\s/]+(@)"), r"\1<redacted>\2"),  # password inside a DSN / URL
]

_SECRET_FIELDS = (
    "telegram_bot_token",
    "telegram_webhook_secret",
    "slack_bot_token",
    "slack_signing_secret",
    "whatsapp_access_token",
    "whatsapp_app_secret",
    "discord_bot_token",
    "fallback_api_key",
    "stt_api_key",
    "jwt_secret",
)


def _configured_secrets() -> list[str]:
    s = get_settings()
    values = [str(getattr(s, f, "") or "") for f in _SECRET_FIELDS]
    values += [p.strip() for p in str(getattr(s, "pia_agent_secret", "") or "").split(",")]
    return [v for v in values if len(v) >= 8]


def redact(text: str) -> str:
    out = text
    for secret in _configured_secrets():
        out = out.replace(secret, "<redacted>")
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out


def safe_error(exc: BaseException | str, limit: int = 500) -> str:
    """Error text that is safe to store in a job, stream to a client or post into a chat."""
    return redact(str(exc))[:limit]


class RedactFilter(logging.Filter):
    """Scrubs every log record (including third-party ones such as httpx request lines)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 — never break logging
            return True
        cleaned = redact(message)
        if cleaned != message:
            record.msg, record.args = cleaned, ()
        return True
