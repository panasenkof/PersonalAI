"""Register MAX webhook: python -m app.channels.max_register --url https://host/v1/channels/max/webhook."""

from __future__ import annotations

import argparse
import asyncio
from urllib.parse import urlsplit

from app.config import get_settings
from app.net.retry import request_json
from app.security.redact import safe_error


async def register(url: str) -> None:
    s = get_settings()
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.port not in (None, 443)
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise ValueError("Webhook requires a public HTTPS URL on port 443")
    if not s.max_bot_token or not s.max_webhook_secret:
        raise ValueError("Set MAX_BOT_TOKEN and MAX_WEBHOOK_SECRET")
    r = await request_json(
        "POST",
        f"{s.max_api_base_url.rstrip('/')}/subscriptions",
        headers={"Authorization": s.max_bot_token},
        json={
            "url": url,
            "secret": s.max_webhook_secret,
            "update_types": ["message_created", "message_callback", "bot_started"],
        },
        label="max/subscriptions",
    )
    if r.json().get("success") is False:
        raise RuntimeError("MAX rejected the webhook subscription")


def main() -> None:
    parser = argparse.ArgumentParser(description="Register the PersonalAI MAX webhook")
    parser.add_argument("--url", required=True, help="Public HTTPS URL ending in /v1/channels/max/webhook")
    args = parser.parse_args()
    try:
        asyncio.run(register(args.url))
    except Exception as exc:
        parser.exit(1, f"{safe_error(exc)}\n")
    print("MAX webhook registered.")


if __name__ == "__main__":
    main()
