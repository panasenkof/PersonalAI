"""Extracted facts awaiting user confirmation (photos / PDFs → structured records).

Handlers call ``stage_or_commit_observation``; when
CONFIRM_EXTRACTED_FACTS is on, the observation is parked as an ExtractedFact and the job ends in
``awaiting_confirm``. The user confirms/rejects from any channel (inline buttons, REST) and only then
does the record enter the knowledge base and search index.
"""

from __future__ import annotations

from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.memory.contracts import NewObservation
from app.memory.sqlalchemy import SqlAlchemyMemoryRepository
from app.models import (
    ExtractedFact,
    ExtractedFactStatus,
    IngestionJob,
    JobStatus,
    utcnow,
)
from app.rag.indexing import index_observation

# Set by process_envelope so tool handlers know which job is running (None: MCP / evals / direct calls)
current_job_id: ContextVar[str | None] = ContextVar("current_job_id", default=None)


def _parse_dt(raw: Any) -> datetime:
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00")) if raw else datetime.now(timezone.utc)
    except ValueError:
        dt = datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def stage_or_commit_observation(
    session: AsyncSession,
    user_id: str,
    *,
    entity_id: str,
    kind: str,
    occurred_at: datetime,
    payload: dict[str, Any],
    summary: str,
    needs_confirmation: bool,
    source_blob_key: str | None = None,
) -> dict[str, Any]:
    """Create the observation now, or stage it as a pending fact (see module docstring)."""
    job_id = current_job_id.get()
    if needs_confirmation and get_settings().confirm_extracted_facts:
        fact = ExtractedFact(
            user_id=user_id,
            job_id=job_id,
            entity_id=entity_id,
            status=ExtractedFactStatus.pending_user_confirm.value,
            payload={
                "kind": kind,
                "summary": summary,
                "occurred_at": occurred_at.isoformat(),
                "observation": payload,
                "source_blob_key": source_blob_key,
            },
        )
        session.add(fact)
        await session.flush()
        return {"fact_id": fact.id, "status": "pending_user_confirm", "summary": summary}
    observation = await SqlAlchemyMemoryRepository(session, user_id).create_observation(NewObservation(
        entity_id=entity_id, occurred_at=occurred_at, kind=kind, payload=payload,
        source_kind="blob" if source_blob_key else None,
        source_ref=source_blob_key,
    ))
    await index_observation(session, user_id, observation)
    return {"observation_id": observation.id, "status": "saved"}


def fact_view(f: ExtractedFact) -> dict[str, Any]:
    p = f.payload or {}
    return {
        "id": f.id,
        "status": f.status,
        "kind": p.get("kind"),
        "summary": p.get("summary"),
        "occurred_at": p.get("occurred_at"),
        "observation_id": f.observation_id,
        "job_id": f.job_id,
        "created_at": f.created_at.isoformat() if f.created_at else None,
    }


async def pending_facts_for_job(session: AsyncSession, job_id: str) -> list[dict[str, Any]]:
    res = await session.execute(
        select(ExtractedFact)
        .where(ExtractedFact.job_id == job_id)
        .where(ExtractedFact.status == ExtractedFactStatus.pending_user_confirm.value)
        .order_by(ExtractedFact.created_at.asc())
    )
    return [fact_view(f) for f in res.scalars().all()]


async def list_facts(session: AsyncSession, user_id: str, status: str | None = None) -> list[ExtractedFact]:
    stmt = select(ExtractedFact).where(ExtractedFact.user_id == user_id)
    if status:
        stmt = stmt.where(ExtractedFact.status == status)
    res = await session.execute(stmt.order_by(ExtractedFact.created_at.desc()).limit(200))
    return list(res.scalars().all())


class FactError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def resolve_fact(session: AsyncSession, user_id: str, fact_id: str, *, confirm: bool) -> dict[str, Any]:
    """Confirm (→ Observation + index) or reject a pending fact. Idempotent per final state."""
    # row lock (Postgres): two simultaneous presses (web + Telegram) must not both create an observation
    fact = await session.get(ExtractedFact, fact_id, with_for_update=True)
    if fact is None or fact.user_id != user_id:
        raise FactError("fact_not_found")
    if fact.status != ExtractedFactStatus.pending_user_confirm.value:
        raise FactError(f"already_{fact.status}")
    p = fact.payload or {}
    if confirm:
        if not fact.entity_id:
            raise FactError("entity_missing")
        observation = await SqlAlchemyMemoryRepository(session, user_id).create_observation(NewObservation(
            entity_id=fact.entity_id,
            occurred_at=_parse_dt(p.get("occurred_at")),
            kind=str(p.get("kind") or "observation"),
            payload=p.get("observation") or {},
            source_kind="blob" if p.get("source_blob_key") else None,
            source_ref=p.get("source_blob_key"),
        ))
        await index_observation(session, user_id, observation)
        fact.observation_id = observation.id
        fact.status = ExtractedFactStatus.committed.value
    else:
        fact.status = ExtractedFactStatus.rejected.value
    fact.resolved_at = utcnow()
    job_status = None
    if fact.job_id:
        job = await session.get(IngestionJob, fact.job_id)
        if job is not None and job.status == JobStatus.awaiting_confirm.value:
            left = await pending_facts_for_job(session, job.id)
            if not [x for x in left if x["id"] != fact.id]:
                job.status = JobStatus.completed.value
                job.updated_at = utcnow()
        job_status = job.status if job is not None else None
    await session.flush()
    return {"fact": fact_view(fact), "job_status": job_status}
