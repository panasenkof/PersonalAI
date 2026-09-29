from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.history import get_or_create_conversation, persist_turn
from app.agent.orchestrator import run_agent
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.ingestion.stt import stt_provider_from_settings
from app.models import IngestionJob, JobStatus
from app.services.facts import current_job_id, pending_facts_for_job


async def build_user_prompt(envelope: IngestionEnvelope) -> str:
    parts: list[str] = []
    if envelope.text:
        parts.append(envelope.text)
    stt = stt_provider_from_settings()
    for att in envelope.attachments:
        if att.mime.startswith("audio/"):
            tr = await stt.transcribe(storage_key=att.storage_key, mime=att.mime)
            if tr:
                parts.append(f"[audio transcript] {tr}")
            else:
                parts.append(f"[audio attachment {att.storage_key}; transcription not configured]")
        elif att.mime.startswith("image/"):
            parts.append(
                f"[image] storage_key={att.storage_key} mime={att.mime}. "
                "If this is a service receipt, call auto_parse_service_receipt with this storage_key and mime when vehicle_entity_id is known."
            )
        elif att.mime == "application/pdf" or (att.filename or "").lower().endswith(".pdf"):
            parts.append(
                f"[pdf document filename={att.filename or '-'} storage_key={att.storage_key} mime=application/pdf]. "
                "If it is a lab report call labs_record_report with this storage_key and mime; "
                "otherwise call kb_ingest_document to save it to the knowledge base."
            )
        else:
            parts.append(
                f"[file attachment filename={att.filename or '-'} storage_key={att.storage_key} mime={att.mime}]. "
                "Text-like files can be saved with kb_ingest_document."
            )
    return "\n\n".join(parts) if parts else "(empty message)"


async def process_envelope(
    session: AsyncSession,
    user_id: str,
    job: IngestionJob,
    envelope: IngestionEnvelope,
    emit: Any | None = None,
) -> dict[str, Any]:
    if job.status != JobStatus.processing.value:  # queue workers already claimed it (no write lock held)
        job.status = JobStatus.processing.value
        job.updated_at = utcnow()
        await session.flush()
    job_token = current_job_id.set(job.id)  # lets tool handlers stage facts for confirmation
    try:
        conv = await get_or_create_conversation(
            session,
            user_id,
            envelope.channel.value,
            conversation_id=envelope.conversation_id,
            external_ref=envelope.external_ref,
        )
        prompt = await build_user_prompt(envelope)
        out = await run_agent(
            session,
            user_id,
            prompt,
            conversation_id=conv.id if conv else None,
            emit=emit,
        )
        if conv is not None and out.get("assistant_text"):
            await persist_turn(session, user_id, conv.id, prompt, out["assistant_text"])
            job.envelope = {**job.envelope, "conversation_id": conv.id}
        usage = (out.get("raw_last") or {}).get("usage")
        if usage:
            out["usage"] = usage  # surfaced via GET /v1/stats for cost visibility
        pending = await pending_facts_for_job(session, job.id)
        if pending:
            out["pending_facts"] = pending  # job waits for the user's confirm/reject decision
        job.status = JobStatus.awaiting_confirm.value if pending else JobStatus.completed.value
        job.result = out
        job.updated_at = utcnow()
        await session.flush()
        return out
    except Exception as exc:  # noqa: BLE001
        job.status = JobStatus.failed.value
        job.error = str(exc)
        job.updated_at = utcnow()
        await session.flush()
        return {"assistant_text": "", "error": str(exc), "failed": True}
    finally:
        current_job_id.reset(job_token)
