from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.history import get_or_create_conversation, persist_turn
from app.agent.orchestrator import run_agent
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.ingestion.stt import StubSTTProvider
from app.models import IngestionJob, JobStatus


async def build_user_prompt(envelope: IngestionEnvelope) -> str:
    parts: list[str] = []
    if envelope.text:
        parts.append(envelope.text)
    stt = StubSTTProvider()
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
        else:
            parts.append(f"[file attachment storage_key={att.storage_key} mime={att.mime}]")
    return "\n\n".join(parts) if parts else "(empty message)"


async def process_envelope(
    session: AsyncSession,
    user_id: str,
    job: IngestionJob,
    envelope: IngestionEnvelope,
    emit: Any | None = None,
) -> dict[str, Any]:
    job.status = JobStatus.processing.value
    job.updated_at = utcnow()
    await session.flush()
    try:
        conv = await get_or_create_conversation(
            session, user_id, envelope.channel.value, conversation_id=envelope.conversation_id
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
        job.status = JobStatus.completed.value
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
