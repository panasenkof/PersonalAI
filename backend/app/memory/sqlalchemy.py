"""SQLAlchemy adapter for MemoryRepository; no commits or implicit search calls."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import TypeVar

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.memory.contracts import (
    CollectionRecord,
    EntityRecord,
    MemoryPage,
    NewCollection,
    NewEntity,
    NewObservation,
    ObservationRecord,
)
from app.memory.repository import MemoryAccessError, MemoryConflictError
from app.models import Collection, Entity, Observation


def _utc(value: datetime | None) -> datetime | None:
    """SQLite drops timezone info; contract timestamps are normalized to UTC."""
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _collection(row: Collection) -> CollectionRecord:
    return CollectionRecord(
        id=row.id, user_id=row.user_id, name=row.name, slug=row.slug,
        description=row.description, sensitivity=row.sensitivity,
    )


def _entity(row: Entity) -> EntityRecord:
    return EntityRecord(
        id=row.id, user_id=row.user_id, collection_id=row.collection_id,
        domain=row.domain, schema_version=row.schema_version,
        payload=deepcopy(row.payload), created_at=_utc(row.created_at) or row.created_at,
        title=row.title, record_status=row.record_status, sensitivity=row.sensitivity,
        valid_from=_utc(row.valid_from), valid_until=_utc(row.valid_until),
        source_kind=row.source_kind, source_ref=row.source_ref,
        updated_at=_utc(row.updated_at),
    )


def _observation(row: Observation) -> ObservationRecord:
    return ObservationRecord(
        id=row.id, user_id=row.user_id, entity_id=row.entity_id,
        occurred_at=_utc(row.occurred_at) or row.occurred_at, kind=row.kind,
        payload=deepcopy(row.payload), created_at=_utc(row.created_at) or row.created_at,
        sensitivity=row.sensitivity, valid_from=_utc(row.valid_from),
        valid_until=_utc(row.valid_until), source_kind=row.source_kind,
        source_ref=row.source_ref, confidence=row.confidence,
    )


T = TypeVar("T")


def _page(items: list[T], *, limit: int, offset: int) -> MemoryPage[T]:
    return MemoryPage(
        items=tuple(items[:limit]),
        next_offset=offset + limit if len(items) > limit else None,
    )


def _paging(limit: int, offset: int) -> None:
    if not (1 <= limit <= 100) or offset < 0:
        raise ValueError("invalid_pagination")


class SqlAlchemyMemoryRepository:
    """One-user view over a caller-owned SQLAlchemy session.

    Repository writes flush but never commit. SQL session and business transaction
    lifetime belong to the API/job/tool caller; nested tool savepoints still work.
    """

    def __init__(self, session: AsyncSession, user_id: str) -> None:
        if not user_id:
            raise ValueError("user_id_required")
        self.session = session
        self.user_id = user_id

    async def list_collections(self) -> list[CollectionRecord]:
        stmt = select(Collection).where(Collection.user_id == self.user_id)
        rows = (await self.session.scalars(stmt.order_by(Collection.id))).all()
        return [_collection(row) for row in rows]

    async def collection_by_id(self, collection_id: str) -> CollectionRecord | None:
        stmt = select(Collection).where(
            Collection.user_id == self.user_id, Collection.id == collection_id,
        )
        row = await self.session.scalar(stmt)
        return _collection(row) if row is not None else None

    async def collection_by_slug(self, slug: str) -> CollectionRecord | None:
        stmt = select(Collection).where(
            Collection.user_id == self.user_id, Collection.slug == slug,
        )
        row = (await self.session.execute(stmt)).scalar_one_or_none()
        return _collection(row) if row is not None else None

    async def create_collection(self, item: NewCollection) -> CollectionRecord:
        if await self.collection_by_slug(item.slug) is not None:
            raise MemoryConflictError("collection_slug_exists")
        row = Collection(
            user_id=self.user_id, name=item.name, slug=item.slug,
            description=item.description, sensitivity=item.sensitivity,
        )
        self.session.add(row)
        await self.session.flush()
        return _collection(row)

    async def entity(self, entity_id: str) -> EntityRecord | None:
        stmt = select(Entity).where(Entity.user_id == self.user_id, Entity.id == entity_id)
        row = await self.session.scalar(stmt)
        return _entity(row) if row is not None else None

    async def entities(
        self, *, domain: str | None = None, collection_id: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> MemoryPage[EntityRecord]:
        _paging(limit, offset)
        stmt = select(Entity).where(Entity.user_id == self.user_id)
        if domain:
            stmt = stmt.where(Entity.domain == domain)
        if collection_id:
            stmt = stmt.where(Entity.collection_id == collection_id)
        rows = (await self.session.scalars(
            stmt.order_by(Entity.created_at, Entity.id).offset(offset).limit(limit + 1)
        )).all()
        return _page([_entity(row) for row in rows], limit=limit, offset=offset)

    async def create_entity(self, item: NewEntity) -> EntityRecord:
        if await self.collection_by_id(item.collection_id) is None:
            raise MemoryAccessError("collection_not_found")
        row = Entity(
            user_id=self.user_id, collection_id=item.collection_id, domain=item.domain,
            schema_version=item.schema_version, payload=deepcopy(item.payload),
            title=item.title, record_status=item.record_status,
            sensitivity=item.sensitivity, valid_from=_utc(item.valid_from),
            valid_until=_utc(item.valid_until), source_kind=item.source_kind,
            source_ref=item.source_ref,
        )
        self.session.add(row)
        await self.session.flush()
        return _entity(row)

    async def observation(self, observation_id: str) -> ObservationRecord | None:
        stmt = select(Observation).where(
            Observation.user_id == self.user_id, Observation.id == observation_id,
        )
        row = await self.session.scalar(stmt)
        return _observation(row) if row is not None else None

    async def observations(
        self, *, entity_id: str | None = None, kind: str | None = None,
        limit: int = 50, offset: int = 0,
    ) -> MemoryPage[ObservationRecord]:
        _paging(limit, offset)
        stmt = select(Observation).where(Observation.user_id == self.user_id)
        if entity_id:
            stmt = stmt.where(Observation.entity_id == entity_id)
        if kind:
            stmt = stmt.where(Observation.kind == kind)
        rows = (await self.session.scalars(
            stmt.order_by(Observation.occurred_at, Observation.id).offset(offset).limit(limit + 1)
        )).all()
        return _page([_observation(row) for row in rows], limit=limit, offset=offset)

    async def create_observation(self, item: NewObservation) -> ObservationRecord:
        if await self.entity(item.entity_id) is None:
            raise MemoryAccessError("entity_not_found")
        if item.confidence is not None and not (0 <= item.confidence <= 1):
            raise ValueError("invalid_confidence")
        row = Observation(
            user_id=self.user_id, entity_id=item.entity_id,
            occurred_at=_utc(item.occurred_at) or item.occurred_at, kind=item.kind,
            payload=deepcopy(item.payload), sensitivity=item.sensitivity,
            valid_from=_utc(item.valid_from), valid_until=_utc(item.valid_until),
            source_kind=item.source_kind, source_ref=item.source_ref,
            confidence=item.confidence,
        )
        self.session.add(row)
        await self.session.flush()
        return _observation(row)
