"""Deliver an agent answer back to the channel the request came from."""

from __future__ import annotations

from typing import Any

from app.ingestion.schemas import IngestionEnvelope


async def send_reply(env: IngestionEnvelope, text: str, pending_facts: list[dict[str, Any]] | None = None) -> None:
    facts = pending_facts or []
    channel = env.channel.value
    if channel == "telegram":
        from app.channels import telegram as m
    elif channel == "slack":
        from app.channels import slack as m  # type: ignore[no-redef]
    elif channel == "whatsapp":
        from app.channels import whatsapp as m  # type: ignore[no-redef]
    elif channel == "discord":
        from app.channels import discord as m  # type: ignore[no-redef]
    else:
        return  # mobile / web read the answer through SSE or polling
    await m.reply(env, text, facts)
