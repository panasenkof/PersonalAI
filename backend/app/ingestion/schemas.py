from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Channel(str, Enum):
    mobile = "mobile"
    telegram = "telegram"


class Attachment(BaseModel):
    mime: str
    storage_key: str
    filename: str | None = None


class IngestionEnvelope(BaseModel):
    text: str | None = None
    attachments: list[Attachment] = Field(default_factory=list)
    channel: Channel = Channel.mobile
    correlation_id: str | None = None
    locale: str | None = None
    conversation_id: str | None = None
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
