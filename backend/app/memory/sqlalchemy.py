"""SQLAlchemy adapter for MemoryRepository; no commits or implicit search calls."""
from __future__ import annotations

import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, TypeVar

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

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
from app.memory.repository import MemoryAccessError, MemoryConflictError
from app.models import Collection, Entity, MemoryRelation, MemoryRevision, Observation, utcnow


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
        updated_at=_utc(row.updated_at), record_version=row.record_version,
    )


def _observation(row: Observation) -> ObservationRecord:
    return ObservationRecord(
        id=row.id, user_id=row.user_id, entity_id=row.entity_id,
        occurred_at=_utc(row.occurred_at) or row.occurred_at, kind=row.kind,
        payload=deepcopy(row.payload), created_at=_utc(row.created_at) or row.created_at,
        sensitivity=row.sensitivity, valid_from=_utc(row.valid_from),
        valid_until=_utc(row.valid_until), source_kind=row.source_kind,
        source_ref=row.source_ref, confidence=row.confidence, record_version=row.record_version,
    )



_RELATION_KIND = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _relation(row: MemoryRelation) -> RelationRecord:
    return RelationRecord(
        id=row.id, user_id=row.user_id, source_entity_id=row.source_entity_id,
        target_entity_id=row.target_entity_id, kind=row.kind,
        created_at=_utc(row.created_at) or row.created_at,
        source_kind=row.source_kind, source_ref=row.source_ref,
    )


def _revision(row: MemoryRevision) -> RevisionRecord:
    record_type = "entity" if row.entity_id is not None else "observation"
    record_id = row.entity_id if row.entity_id is not None else row.observation_id
    return RevisionRecord(
        id=row.id, user_id=row.user_id, record_type=record_type,
        record_id=record_id or "", version=row.version,
        reason=row.reason, actor_kind=row.actor_kind,
        before_state=deepcopy(row.before_state), after_state=deepcopy(row.after_state),
        created_at=_utc(row.created_at) or row.created_at,
    )


def _time_string(value: datetime | None) -> str | None:
    normalized = _utc(value)
    return normalized.isoformat() if normalized is not None else None


def _entity_state(row: Entity) -> dict[str, Any]:
    return {
        "payload": deepcopy(row.payload), "title": row.title,
        "record_status": row.record_status, "sensitivity": row.sensitivity,
        "valid_from": _time_string(row.valid_from), "valid_until": _time_string(row.valid_until),
        "source_kind": row.source_kind, "source_ref": row.source_ref,
    }


def _observation_state(row: Observation) -> dict[str, Any]:
    return {
        "payload": deepcopy(row.payload), "kind": row.kind,
        "occurred_at": _time_string(row.occurred_at),
        "sensitivity": row.sensitivity,
        "valid_from": _time_string(row.valid_from), "valid_until": _time_string(row.valid_until),
        "source_kind": row.source_kind, "source_ref": row.source_ref,
        "confidence": row.confidence,
    }


def _validate_correction(expected_version: int, reason: str, actor_kind: str) -> None:
    if expected_version < 1:
        raise ValueError("invalid_expected_version")
    if not reason.strip() or len(reason) > 512:
        raise ValueError("invalid_reason")
    if not actor_kind.strip() or len(actor_kind) > 32:
        raise ValueError("invalid_actor_kind")


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


    async def link_entities(
        self, *, source_entity_id: str, target_entity_id: str, kind: str,
        source_kind: str | None = None, source_ref: str | None = None,
    ) -> RelationRecord:
        if source_entity_id == target_entity_id:
            raise ValueError("self_relation_not_allowed")
        if _RELATION_KIND.fullmatch(kind) is None:
            raise ValueError("invalid_relation_kind")
        if await self.entity(source_entity_id) is None or await self.entity(target_entity_id) is None:
            raise MemoryAccessError("entity_not_found")
        existing = await self.session.scalar(
            select(MemoryRelation).where(
                MemoryRelation.user_id == self.user_id,
                MemoryRelation.source_entity_id == source_entity_id,
                MemoryRelation.target_entity_id == target_entity_id,
                MemoryRelation.kind == kind,
            )
        )
        if existing is not None:
            raise MemoryConflictError("relation_exists")
        row = MemoryRelation(
            user_id=self.user_id, source_entity_id=source_entity_id,
            target_entity_id=target_entity_id, kind=kind,
            source_kind=source_kind, source_ref=source_ref,
        )
        self.session.add(row)
        await self.session.flush()
        return _relation(row)

    async def relations_for_entity(self, entity_id: str) -> list[RelationRecord]:
        if await self.entity(entity_id) is None:
            return []
        rows = (await self.session.scalars(
            select(MemoryRelation).where(
                MemoryRelation.user_id == self.user_id,
                or_(
                    MemoryRelation.source_entity_id == entity_id,
                    MemoryRelation.target_entity_id == entity_id,
                ),
            ).order_by(MemoryRelation.created_at, MemoryRelation.id)
        )).all()
        return [_relation(row) for row in rows]

    async def revise_entity(
        self, entity_id: str, *, expected_version: int, payload: dict,
        reason: str, actor_kind: str = "user", record_status: str | None = None,
    ) -> EntityRecord:
        _validate_correction(expected_version, reason, actor_kind)
        row = await self.session.scalar(
            select(Entity).where(Entity.id == entity_id, Entity.user_id == self.user_id)
        )
        if row is None:
            raise MemoryAccessError("entity_not_found")
        if row.record_version != expected_version:
            raise MemoryConflictError("stale_memory_version")
        before = _entity_state(row)
        new_status = row.record_status if record_status is None else record_status
        if new_status not in ("active", "archived", "superseded"):
            raise ValueError("invalid_record_status")
        new_payload = deepcopy(payload)
        # Compare-and-swap runs atomically inside caller's transaction, including
        # simultaneous updates on PostgreSQL. SQLite uses the same version guard.
        updated_id = await self.session.scalar(
            update(Entity).where(
                Entity.id == entity_id, Entity.user_id == self.user_id,
                Entity.record_version == expected_version,
            ).values(
                payload=new_payload, record_status=new_status,
                record_version=expected_version + 1, updated_at=utcnow(),
            ).returning(Entity.id).execution_options(synchronize_session=False)
        )
        if updated_id is None:
            raise MemoryConflictError("stale_memory_version")
        await self.session.refresh(row)
        self.session.add(MemoryRevision(
            user_id=self.user_id, entity_id=entity_id, observation_id=None,
            version=expected_version + 1, reason=reason.strip(),
            actor_kind=actor_kind.strip(), before_state=before, after_state=_entity_state(row),
        ))
        await self.session.flush()
        return _entity(row)

    async def revise_observation(
        self, observation_id: str, *, expected_version: int, payload: dict,
        reason: str, actor_kind: str = "user",
    ) -> ObservationRecord:
        _validate_correction(expected_version, reason, actor_kind)
        row = await self.session.scalar(
            select(Observation).where(
                Observation.id == observation_id, Observation.user_id == self.user_id,
            )
        )
        if row is None:
            raise MemoryAccessError("observation_not_found")
        if row.record_version != expected_version:
            raise MemoryConflictError("stale_memory_version")
        before = _observation_state(row)
        updated_id = await self.session.scalar(
            update(Observation).where(
                Observation.id == observation_id, Observation.user_id == self.user_id,
                Observation.record_version == expected_version,
            ).values(
                payload=deepcopy(payload), record_version=expected_version + 1,
            ).returning(Observation.id).execution_options(synchronize_session=False)
        )
        if updated_id is None:
            raise MemoryConflictError("stale_memory_version")
        await self.session.refresh(row)
        self.session.add(MemoryRevision(
            user_id=self.user_id, entity_id=None, observation_id=observation_id,
            version=expected_version + 1, reason=reason.strip(),
            actor_kind=actor_kind.strip(), before_state=before, after_state=_observation_state(row),
        ))
        await self.session.flush()
        return _observation(row)

    async def revisions(self, *, record_type: str, record_id: str) -> list[RevisionRecord]:
        if record_type == "entity":
            if await self.entity(record_id) is None:
                return []
            condition = MemoryRevision.entity_id == record_id
        elif record_type == "observation":
            if await self.observation(record_id) is None:
                return []
            condition = MemoryRevision.observation_id == record_id
        else:
            raise ValueError("invalid_record_type")
        rows = (await self.session.scalars(
            select(MemoryRevision).where(
                MemoryRevision.user_id == self.user_id, condition,
            ).order_by(MemoryRevision.version)
        )).all()
        return [_revision(row) for row in rows]
