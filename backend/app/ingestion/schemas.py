from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Channel(str, Enum):
    mobile = "mobile"
    telegram = "telegram"
    slack = "slack"
    whatsapp = "whatsapp"
    discord = "discord"
    web = "web"


class Attachment(BaseModel):
    mime: str = Field(max_length=255)
    storage_key: str = Field(max_length=512)
    filename: str | None = Field(default=None, max_length=255)


class IngestionEnvelope(BaseModel):
    text: str | None = Field(default=None, max_length=20_000)
    attachments: list[Attachment] = Field(default_factory=list, max_length=10)
    channel: Channel = Channel.mobile
    correlation_id: str | None = None
    locale: str | None = None
    conversation_id: str | None = None
    # Stable messenger thread id (telegram:<chat>, slack:<channel>[:<thread>], ...) → conversation memory
    external_ref: str | None = None
    channel_meta: dict[str, Any] = Field(default_factory=dict)


class IngestionJobView(BaseModel):
    id: str
    status: str
    correlation_id: str | None
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
