from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.history import get_or_create_conversation
from app.api.deps import get_current_user
from app.api.schemas import JobOut, MessageIn, MessageOut
from app.config import get_settings
from app.db import get_session
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import IngestionEnvelope
from app.models import IngestionJob, JobStatus, User
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
    if body.conversation_id:
        existing = await get_or_create_conversation(
            session, user.id, body.channel.value, conversation_id=body.conversation_id
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="conversation_not_found")
    env = IngestionEnvelope(
        text=body.text,
        attachments=body.attachments,
        channel=body.channel,
        correlation_id=body.correlation_id,
        conversation_id=body.conversation_id,
    )
    job = IngestionJob(
        user_id=user.id,
        status=JobStatus.accepted.value,
        correlation_id=body.correlation_id,
        envelope=env.model_dump(mode="json"),
    )
    session.add(job)
    await session.flush()
    out = await process_envelope(session, user.id, job, env)
    await session.commit()
    return MessageOut(
        job_id=job.id,
        status=job.status,
        assistant_text=out.get("assistant_text"),
        error=out.get("error") if out.get("failed") else None,
        conversation_id=(job.envelope or {}).get("conversation_id") or body.conversation_id,
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
