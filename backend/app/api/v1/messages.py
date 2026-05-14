from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.schemas import JobOut, MessageIn, MessageOut
from app.db import get_session
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import IngestionEnvelope
from app.models import IngestionJob, JobStatus, User
from app.storage.blob import save_bytes

router = APIRouter(prefix="/v1", tags=["messages"])


@router.post("/blobs", response_model=dict)
async def upload_blob(
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    _ = user
    data = await file.read()
    mime = file.content_type or "application/octet-stream"
    key, sha, size = await save_bytes(data, mime)
    return {"storage_key": key, "sha256": sha, "size_bytes": size, "mime": mime}


@router.post("/messages", response_model=MessageOut)
async def post_message(
    body: MessageIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> MessageOut:
    env = IngestionEnvelope(
        text=body.text,
        attachments=body.attachments,
        channel=body.channel,
        correlation_id=body.correlation_id,
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
