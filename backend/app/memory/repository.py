"""Storage-independent memory interface.

A repository instance is scoped to one authenticated owner. All lookups and
writes MUST enforce that scope, including foreign-key references. Implementations
flush changes but MUST NOT commit: the caller controls transactions and rollback.
Search indexing is a separate responsibility of the application service.
"""
from __future__ import annotations

from typing import Protocol

from app.memory.contracts import (
    CollectionRecord,
    EntityRecord,
    MemoryPage,
    NewCollection,
    NewEntity,
    NewObservation,
    ObservationRecord,
    RelationRecord,
    RevisionRecord,
)


class MemoryAccessError(ValueError):
    """The referenced record does not exist or belongs to a different owner."""


class MemoryConflictError(ValueError):
    """A scoped identifier (e.g. collection slug) is already in use."""


class MemoryRepository(Protocol):
    async def list_collections(self) -> list[CollectionRecord]: ...

    async def collection_by_id(self, collection_id: str) -> CollectionRecord | None: ...

    async def collection_by_slug(self, slug: str) -> CollectionRecord | None: ...

    async def create_collection(self, item: NewCollection) -> CollectionRecord: ...

    async def entity(self, entity_id: str) -> EntityRecord | None: ...

    async def entities(
        self, *, domain: str | None = None, collection_id: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> MemoryPage[EntityRecord]: ...

    async def create_entity(self, item: NewEntity) -> EntityRecord: ...

    async def observation(self, observation_id: str) -> ObservationRecord | None: ...

    async def observations(
        self, *, entity_id: str | None = None, kind: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> MemoryPage[ObservationRecord]: ...

    async def create_observation(self, item: NewObservation) -> ObservationRecord: ...
 
    async def link_entities(
        self, *, source_entity_id: str, target_entity_id: str, kind: str,
        source_kind: str | None = None, source_ref: str | None = None,
    ) -> RelationRecord: ...

    async def relations_for_entity(self, entity_id: str) -> list[RelationRecord]: ...

    async def revise_entity(
        self, entity_id: str, *, expected_version: int, payload: dict,
        reason: str, actor_kind: str = "user", record_status: str | None = None,
    ) -> EntityRecord: ...

    async def revise_observation(
        self, observation_id: str, *, expected_version: int, payload: dict,
        reason: str, actor_kind: str = "user",
    ) -> ObservationRecord: ...

    async def revisions(self, *, record_type: str, record_id: str) -> list[RevisionRecord]: ...
