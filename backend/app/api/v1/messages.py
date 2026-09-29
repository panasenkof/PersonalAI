from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.history import get_or_create_conversation
from app.api.deps import get_current_user, get_current_user_flexible
from app.api.schemas import JobOut, MessageIn, MessageOut
from app.config import get_settings
from app.db import SessionLocal, get_session
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import IngestionEnvelope
from app.llm.limits import RateLimitExceeded, check_user_quota
from app.models import SETTLED_JOB_STATUSES, IngestionJob, JobStatus, User
from app.queue.events import bus
from app.queue.jobs import request_job_cancel
from app.services.blobs import store_blob, user_owns_blob

router = APIRouter(prefix="/v1", tags=["messages"])


@router.post("/blobs", response_model=dict)
async def upload_blob(
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    limit = get_settings().max_upload_bytes
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail="file_too_large")
    mime = file.content_type or "application/octet-stream"
    blob = await store_blob(session, user.id, data, mime, filename=file.filename)
    await session.commit()
    return {
        "storage_key": blob.storage_key,
        "sha256": blob.sha256,
        "size_bytes": str(blob.size_bytes),
        "mime": blob.mime,
    }


@router.post("/messages", response_model=MessageOut)
async def post_message(
    body: MessageIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> MessageOut:
    for att in body.attachments:
        if not await user_owns_blob(session, user.id, att.storage_key):
            raise HTTPException(status_code=422, detail="unknown_storage_key")
    try:
        await check_user_quota(user.id)
    except RateLimitExceeded as exc:
        raise HTTPException(
            status_code=429, detail="rate_limited", headers={"Retry-After": str(exc.retry_after)}
        ) from None

    conv = await get_or_create_conversation(
        session, user.id, body.channel.value, conversation_id=body.conversation_id
    )
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation_not_found")

    env = IngestionEnvelope(
        text=body.text,
        attachments=body.attachments,
        channel=body.channel,
        correlation_id=body.correlation_id,
        conversation_id=conv.id,
    )
    job = IngestionJob(
        user_id=user.id,
        status=JobStatus.accepted.value,
        correlation_id=body.correlation_id,
        envelope=env.model_dump(mode="json"),
    )
    session.add(job)
    await session.flush()

    if get_settings().message_mode == "queue":
        # Fast accept: persist the job, process in background, stream via SSE.
        await session.commit()
        from app.queue.runner import get_runner

        await get_runner().enqueue(job.id)
        return MessageOut(job_id=job.id, status=job.status, conversation_id=conv.id)

    out = await process_envelope(session, user.id, job, env)
    await session.commit()
    return MessageOut(
        job_id=job.id,
        status=job.status,
        assistant_text=out.get("assistant_text"),
        error=out.get("error") if out.get("failed") else None,
        conversation_id=conv.id,
        pending_facts=out.get("pending_facts") or [],
    )


@router.get("/jobs/{job_id}", response_model=JobOut)
async def get_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> JobOut:
    job = await session.get(IngestionJob, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(404, detail="job_not_found")
    return JobOut(
        id=job.id,
        status=job.status,
        result=job.result,
        error=job.error,
        pending_facts=(job.result or {}).get("pending_facts") or [],
    )


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
async def cancel_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> JobOut:
    """Stop a queued or running job ("Stop" button). The run is rolled back; any partial
    answer that was already streamed stays in the conversation."""
    job = await session.get(IngestionJob, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(404, detail="job_not_found")
    if job.status in SETTLED_JOB_STATUSES:
        return JobOut(id=job.id, status=job.status, result=job.result, error=job.error)
    job = await request_job_cancel(session, job)
    return JobOut(id=job.id, status=job.status)


def _sse(event: dict) -> str:
    return f"event: {event.get('type', 'message')}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


def _settled_event(row: IngestionJob) -> dict:
    """Terminal SSE payload derived from persisted state (late subscribers / out-of-process workers)."""
    result = row.result or {}
    if row.status == JobStatus.failed.value:
        return {"type": "error", "text": row.error or "failed"}
    if row.status == JobStatus.cancelled.value:
        return {"type": "cancelled", "text": ""}
    return {
        "type": "done",
        "text": result.get("assistant_text") or "",
        "pending_facts": result.get("pending_facts") or [],
        "status": row.status,
        "conversation_id": (row.envelope or {}).get("conversation_id"),
    }


@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    access_token: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user_flexible),
) -> StreamingResponse:
    """SSE stream: status → token / tool_call / tool_start / tool events → done | error | cancelled.

    `access_token` query param exists because EventSource cannot set headers.
    """
    _ = access_token
    job = await session.get(IngestionJob, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(404, detail="job_not_found")

    async def gen():
        if job.status in SETTLED_JOB_STATUSES:
            yield _sse(_settled_event(job))
            return

        yield _sse({"type": "status", "status": job.status})
        q = bus.subscribe(job_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=1.0)
                except TimeoutError:
                    # fallback: refresh from DB (covers out-of-process workers / lost events)
                    async with SessionLocal() as fresh:
                        row = await fresh.get(IngestionJob, job_id)
                        if row is None:
                            yield _sse({"type": "error", "text": "job disappeared"})
                            return
                        if row.status in SETTLED_JOB_STATUSES:
                            yield _sse(_settled_event(row))
                            return
                    continue
                yield _sse(event)
                if event.get("type") in ("done", "error", "cancelled"):
                    return
        finally:
            bus.unsubscribe(job_id, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
