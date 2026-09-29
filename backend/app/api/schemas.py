from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.ingestion.schemas import Attachment, Channel


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    refresh_token: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class LLMSettingsIn(BaseModel):
    provider_kind: Literal["cloud", "local"]
    base_url: str
    api_key: str | None = None
    default_model: str
    embedding_model: str | None = None
    supports_vision: bool = True


class LLMSettingsOut(BaseModel):
    provider_kind: str
    base_url: str
    default_model: str
    embedding_model: str | None
    supports_vision: bool


class MessageIn(BaseModel):
    text: str | None = None
    channel: Channel = Channel.mobile
    correlation_id: str | None = None
    attachments: list[Attachment] = []
    conversation_id: str | None = None


class MessageOut(BaseModel):
    job_id: str
    status: str
    assistant_text: str | None = None
    error: str | None = None
    conversation_id: str | None = None


class ConversationOut(BaseModel):
    id: str
    channel: str
    title: str | None = None
    created_at: datetime
    updated_at: datetime


class ChatTurnOut(BaseModel):
    role: str
    content: str
    created_at: datetime


class JobOut(BaseModel):
    id: str
    status: str
    result: dict | None = None
    error: str | None = None
