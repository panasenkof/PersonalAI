from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.ingestion.schemas import Attachment, Channel


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


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


class MessageOut(BaseModel):
    job_id: str
    status: str
    assistant_text: str | None = None
    error: str | None = None


class JobOut(BaseModel):
    id: str
    status: str
    result: dict | None = None
    error: str | None = None
