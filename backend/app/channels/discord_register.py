"""Register the slash commands: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set.

    python -m app.channels.discord_register [guild_id]     # guild commands appear instantly
"""

from __future__ import annotations

import sys

import httpx

from app.config import get_settings

STRING, ATTACHMENT = 3, 11

COMMANDS = [
    {
        "name": "ask",
        "description": "Ask PIA or save something to your knowledge base",
        "options": [
            {"type": STRING, "name": "text", "description": "Your message", "required": True},
            {"type": ATTACHMENT, "name": "file", "description": "Photo / PDF / document", "required": False},
        ],
    },
    {
        "name": "link",
        "description": "Link this Discord account to your PIA account",
        "options": [{"type": STRING, "name": "code", "description": "Code from the app", "required": True}],
    },
    {"name": "stop", "description": "Stop the running request"},
    {"name": "new", "description": "Start a new conversation"},
]


def main() -> int:
    s = get_settings()
    if not (s.discord_bot_token and s.discord_application_id):
        print("Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID")
        return 1
    base = f"https://discord.com/api/v10/applications/{s.discord_application_id}"
    url = f"{base}/guilds/{sys.argv[1]}/commands" if len(sys.argv) > 1 else f"{base}/commands"
    r = httpx.put(url, json=COMMANDS, headers={"Authorization": f"Bot {s.discord_bot_token}"}, timeout=30)
    r.raise_for_status()
    print(f"registered {len(r.json())} commands")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
