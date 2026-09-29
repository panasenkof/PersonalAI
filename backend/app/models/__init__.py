from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    DDL,
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    event,
    false,
    true,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.config import get_settings
from app.security.crypto import EncryptedJSON, EncryptedText

PGVECTOR_AVAILABLE = False
_VECTOR_TYPE: Any = JSON()
if get_settings().use_pgvector:
    try:  # optional: without the package (or off Postgres) embeddings live in the JSON column only
        from pgvector.sqlalchemy import Vector as _Vector

        _VECTOR_TYPE = _Vector(get_settings().pgvector_dimensions).with_variant(JSON(), "sqlite")
        PGVECTOR_AVAILABLE = True
    except ImportError:  # pragma: no cover
        pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class ProviderKind(str, enum.Enum):
    cloud = "cloud"
    local = "local"


class JobStatus(str, enum.Enum):
    accepted = "accepted"
    processing = "processing"
    awaiting_confirm = "awaiting_confirm"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


# Jobs in these states will not change any more without user action
TERMINAL_JOB_STATUSES = frozenset(
    {JobStatus.completed.value, JobStatus.failed.value, JobStatus.cancelled.value}
)
# ...and these are ones the client can stop waiting on (awaiting_confirm needs a user decision)
SETTLED_JOB_STATUSES = TERMINAL_JOB_STATUSES | {JobStatus.awaiting_confirm.value}


class UserRole(str, enum.Enum):
    user = "user"
    admin = "admin"


class ExtractedFactStatus(str, enum.Enum):
    pending_user_confirm = "pending_user_confirm"
    committed = "committed"
    rejected = "rejected"


class ScheduleStatus(str, enum.Enum):
    draft = "draft"
    approved = "approved"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    telegram_user_id: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)
    slack_user_id: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)
    whatsapp_user_id: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)
    discord_user_id: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)
    role: Mapped[str] = mapped_column(String(16), default=UserRole.user.value, server_default="user")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    # Bumped on password change / logout-all: older tokens stop working
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    totp_secret: Mapped[Optional[str]] = mapped_column(EncryptedText, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    recovery_codes: Mapped[Optional[list[str]]] = mapped_column(JSON, nullable=True)  # sha256 hashes
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    llm_settings: Mapped["LLMSettings"] = relationship(back_populates="user", uselist=False)
    collections: Mapped[list["Collection"]] = relationship(back_populates="user")


class TelegramLinkCode(Base):
    __tablename__ = "telegram_link_codes"
    __table_args__ = (UniqueConstraint("code", name="uq_telegram_link_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(12), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class LLMSettings(Base):
    __tablename__ = "llm_settings"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    provider_kind: Mapped[str] = mapped_column(String(16), default=ProviderKind.cloud.value)
    base_url: Mapped[str] = mapped_column(String(512), default="https://api.openai.com/v1")
    api_key_ciphertext: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    api_key_plain: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)  # dev fallback
    default_model: Mapped[str] = mapped_column(String(128), default="gpt-4o-mini")
    embedding_model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    supports_vision: Mapped[bool] = mapped_column(Boolean, default=True)

    user: Mapped["User"] = relationship(back_populates="llm_settings")


class Collection(Base):
    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str] = mapped_column(String(64), index=True)

    user: Mapped["User"] = relationship(back_populates="collections")
    entities: Mapped[list["Entity"]] = relationship(back_populates="collection")


class Entity(Base):
    __tablename__ = "entities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    collection_id: Mapped[str] = mapped_column(ForeignKey("collections.id", ondelete="CASCADE"), index=True)
    domain: Mapped[str] = mapped_column(String(64), index=True)
    schema_version: Mapped[str] = mapped_column(String(32), default="1")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    collection: Mapped["Collection"] = relationship(back_populates="entities")
    observations: Mapped[list["Observation"]] = relationship(back_populates="entity")


class Observation(Base):
    __tablename__ = "observations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    entity_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"), index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    kind: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    entity: Mapped["Entity"] = relationship(back_populates="observations")


class Blob(Base):
    __tablename__ = "blobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    storage_key: Mapped[str] = mapped_column(String(512), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    mime: Mapped[str] = mapped_column(String(128))
    filename: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ExtractedFact(Base):
    __tablename__ = "extracted_facts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    observation_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("observations.id", ondelete="SET NULL"), nullable=True
    )
    entity_id: Mapped[Optional[str]] = mapped_column(ForeignKey("entities.id", ondelete="SET NULL"), nullable=True)
    job_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("ingestion_jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(32), default=ExtractedFactStatus.pending_user_confirm.value)
    # {"kind": "service_event" | "lab_report", "summary": str, "observation": {...}}
    payload: Mapped[dict[str, Any]] = mapped_column(EncryptedJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    entity_id: Mapped[Optional[str]] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"), nullable=True)
    observation_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("observations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    text: Mapped[str] = mapped_column(Text)
    # Portable storage (SQLite, or embeddings whose width differs from PGVECTOR_DIMENSIONS)
    embedding: Mapped[Optional[list[float]]] = mapped_column(JSON(none_as_null=True), nullable=True)
    # Native pgvector column (Postgres): indexed with HNSW for cosine ANN search
    embedding_vec: Mapped[Optional[Any]] = mapped_column(_VECTOR_TYPE, nullable=True, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(32), default=JobStatus.accepted.value)
    correlation_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    envelope: Mapped[dict[str, Any]] = mapped_column(EncryptedJSON)
    result: Mapped[Optional[dict[str, Any]]] = mapped_column(EncryptedJSON, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ScheduleCandidate(Base):
    __tablename__ = "schedule_candidates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    vehicle_entity_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"), index=True)
    source_url: Mapped[str] = mapped_column(String(1024))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    structured: Mapped[dict[str, Any]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(32), default=ScheduleStatus.draft.value)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    channel: Mapped[str] = mapped_column(String(16), default="mobile")
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Stable id of the external thread (telegram:<chat>, slack:<channel>:<thread_ts>, ...)
    external_ref: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    user: Mapped["User"] = relationship()  # noqa: F821


class ChatTurn(Base):
    __tablename__ = "chat_turns"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    content: Mapped[str] = mapped_column(EncryptedText)  # encrypted at rest when PIA_AGENT_SECRET is set
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ReminderNotification(Base):
    __tablename__ = "reminder_notifications"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "entity_id", "item", "sent_on", name="uq_reminder_once_per_day"
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    entity_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"), index=True)
    item: Mapped[str] = mapped_column(String(128))
    sent_on: Mapped[str] = mapped_column(String(10))  # YYYY-MM-DD
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# --- Postgres-only DDL: pgvector + trigram indexes (no-ops on SQLite) ---------------------------
_PG = "postgresql"
if PGVECTOR_AVAILABLE:
    event.listen(
        Chunk.__table__,
        "before_create",
        DDL("CREATE EXTENSION IF NOT EXISTS vector").execute_if(dialect=_PG),
    )
    event.listen(
        Chunk.__table__,
        "after_create",
        DDL(
            "CREATE INDEX IF NOT EXISTS ix_chunks_embedding_hnsw "
            "ON chunks USING hnsw (embedding_vec vector_cosine_ops)"
        ).execute_if(dialect=_PG),
    )
event.listen(
    Chunk.__table__,
    "after_create",
    DDL(
        "DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; "
        "CREATE INDEX IF NOT EXISTS ix_chunks_text_trgm ON chunks USING gin (text gin_trgm_ops); "
        "EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm unavailable: substring search stays unindexed'; "
        "END $$"
    ).execute_if(dialect=_PG),
)
