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
from app.models import IngestionJob, JobStatus, User
from app.queue.events import bus
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

        get_runner().enqueue(job.id)
        return MessageOut(job_id=job.id, status=job.status, conversation_id=conv.id)

    out = await process_envelope(session, user.id, job, env)
    await session.commit()
    return MessageOut(
        job_id=job.id,
        status=job.status,
        assistant_text=out.get("assistant_text"),
        error=out.get("error") if out.get("failed") else None,
        conversation_id=conv.id,
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
    return JobOut(id=job.id, status=job.status, result=job.result, error=job.error)


def _sse(event: dict) -> str:
    return f"event: {event.get('type', 'message')}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    access_token: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user_flexible),
) -> StreamingResponse:
    """SSE stream: status → token/tool events → done/error.

    `access_token` query param exists because EventSource cannot set headers.
    """
    _ = access_token
    job = await session.get(IngestionJob, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(404, detail="job_not_found")

    async def gen():
        if job.status in (JobStatus.completed.value, JobStatus.failed.value):
            text = (job.result or {}).get("assistant_text") or ""
            if job.status == JobStatus.failed.value:
                yield _sse({"type": "error", "text": job.error or "failed"})
            else:
                yield _sse({"type": "done", "text": text})
            return

        yield _sse({"type": "status", "status": job.status})
        q = bus.subscribe(job_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=1.0)
                except TimeoutError:
                    # fallback: refresh from DB (covers out-of-process workers)
                    async with SessionLocal() as fresh:
                        row = await fresh.get(IngestionJob, job_id)
                        if row is None:
                            yield _sse({"type": "error", "text": "job disappeared"})
                            return
                        if row.status == JobStatus.completed.value:
                            text = (row.result or {}).get("assistant_text") or ""
                            yield _sse({"type": "done", "text": text})
                            return
                        if row.status == JobStatus.failed.value:
                            yield _sse({"type": "error", "text": row.error or "failed"})
                            return
                    continue
                yield _sse(event)
                if event.get("type") in ("done", "error"):
                    return
        finally:
            bus.unsubscribe(job_id, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
