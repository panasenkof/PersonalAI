"""Deliver an agent answer back to the channel the request came from."""

from __future__ import annotations

from typing import Any

from app.ingestion.schemas import IngestionEnvelope


async def send_reply(env: IngestionEnvelope, text: str, pending_facts: list[dict[str, Any]] | None = None) -> None:
    facts = pending_facts or []
    channel = env.channel.value
    meta = env.channel_meta or {}
    if channel in {"telegram", "slack", "whatsapp"} and not meta.get("chat_id"):
        raise ValueError("channel_reply_destination_missing")
    if channel == "max" and meta.get("user_id") is None:
        raise ValueError("max_reply_destination_missing")
    if channel == "discord" and not (meta.get("interaction_token") and meta.get("application_id")):
        raise ValueError("discord_reply_destination_missing")
    if channel == "telegram":
        from app.channels import telegram as m
    elif channel == "max":
        from app.channels import max as m  # type: ignore[no-redef]
    elif channel == "slack":
        from app.channels import slack as m  # type: ignore[no-redef]
    elif channel == "whatsapp":
        from app.channels import whatsapp as m  # type: ignore[no-redef]
    elif channel == "discord":
        from app.channels import discord as m  # type: ignore[no-redef]
    else:
        return  # mobile / web read the answer through SSE or polling
    await m.reply(env, text, facts)
