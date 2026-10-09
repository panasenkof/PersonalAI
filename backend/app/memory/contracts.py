"""Portable, detached data transfer objects for personal memory.

No imports from SQLAlchemy, FastAPI, LLM providers or application configuration.
These are Python-side contracts. Wire serialization and sync revision semantics
will be specified in a separate phase.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Generic, TypeVar


@dataclass(frozen=True, slots=True)
class CollectionRecord:
    id: str
    user_id: str
    name: str
    slug: str
    description: str | None = None
    sensitivity: str = "unclassified"


@dataclass(frozen=True, slots=True)
class EntityRecord:
    id: str
    user_id: str
    collection_id: str
    domain: str
    schema_version: str
    payload: dict[str, Any]
    created_at: datetime
    title: str | None = None
    record_status: str = "active"
    sensitivity: str = "inherit"
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    source_kind: str | None = None
    source_ref: str | None = None
    updated_at: datetime | None = None
    record_version: int = 1


@dataclass(frozen=True, slots=True)
class ObservationRecord:
    id: str
    user_id: str
    entity_id: str
    occurred_at: datetime
    kind: str
    payload: dict[str, Any]
    created_at: datetime
    sensitivity: str = "inherit"
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    source_kind: str | None = None
    source_ref: str | None = None
    confidence: float | None = None
    record_version: int = 1


@dataclass(frozen=True, slots=True)
class RelationRecord:
    id: str
    user_id: str
    source_entity_id: str
    target_entity_id: str
    kind: str
    created_at: datetime
    source_kind: str | None = None
    source_ref: str | None = None


@dataclass(frozen=True, slots=True)
class RevisionRecord:
    id: str
    user_id: str
    record_type: str
    record_id: str
    version: int
    reason: str
    actor_kind: str
    before_state: dict[str, Any]
    after_state: dict[str, Any]
    created_at: datetime


@dataclass(frozen=True, slots=True)
class NewCollection:
    name: str
    slug: str
    description: str | None = None
    sensitivity: str = "unclassified"


@dataclass(frozen=True, slots=True)
class NewEntity:
    collection_id: str
    domain: str
    payload: dict[str, Any]
    schema_version: str = "1"
    title: str | None = None
    record_status: str = "active"
    sensitivity: str = "inherit"
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    source_kind: str | None = None
    source_ref: str | None = None


@dataclass(frozen=True, slots=True)
class NewObservation:
    entity_id: str
    occurred_at: datetime
    kind: str
    payload: dict[str, Any]
    sensitivity: str = "inherit"
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    source_kind: str | None = None
    source_ref: str | None = None
    confidence: float | None = None


T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class MemoryPage(Generic[T]):
    items: tuple[T, ...]
    next_offset: int | None
