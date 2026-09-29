from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import update

from app.agent.history import get_or_create_conversation, persist_turn
from app.config import get_settings
from app.db import SessionLocal
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.models import SETTLED_JOB_STATUSES, IngestionJob, JobStatus
from app.queue.events import bus

logger = logging.getLogger(__name__)

CANCEL_SUFFIX = "\n\n…[остановлено]"


async def claim_job(job_id: str) -> IngestionJob | None:
    """Atomically move accepted → processing (attempt++). Returns None if someone else owns it,
    it is finished/cancelled, or attempts are exhausted (then it is marked failed)."""
    max_attempts = max(1, get_settings().job_max_attempts)
    async with SessionLocal() as session:
        job = await session.get(IngestionJob, job_id)
        if job is None:
            logger.error("job %s not found", job_id)
            return None
        if job.status != JobStatus.accepted.value:
            return None
        if (job.attempts or 0) >= max_attempts:
            job.status = JobStatus.failed.value
            job.error = f"max attempts ({max_attempts}) exceeded (worker crashed or restarted repeatedly)"
            job.updated_at = utcnow()
            await session.commit()
            await bus.publish(job_id, {"type": "error", "text": job.error})
            return None
        res = await session.execute(
            update(IngestionJob)
            .where(IngestionJob.id == job_id)
            .where(IngestionJob.status == JobStatus.accepted.value)
            .values(status=JobStatus.processing.value, attempts=(job.attempts or 0) + 1, updated_at=utcnow())
        )
        await session.commit()
        if res.rowcount != 1:  # type: ignore[attr-defined]
            return None
        await session.refresh(job)
        return job


async def execute_job(job_id: str) -> dict:
    """Process an ingestion job outside the HTTP request cycle.

    Claims the job atomically (safe with several workers / duplicate deliveries), streams
    token/tool events on the EventBus, dispatches the channel reply. Any crash outside
    process_envelope's own handler marks the job failed so SSE subscribers and pollers
    terminate instead of hanging. Cancellation (user pressed Stop) rolls the run back and
    keeps whatever partial answer had been streamed in the conversation.
    """
    job = await claim_job(job_id)
    if job is None:
        return {"skipped": True}
    state: dict[str, Any] = {"partial": ""}
    try:
        return await _execute_job_inner(job_id, state)
    except asyncio.CancelledError:
        if bus.consume_cancel(job_id) or await _is_cancelled(job_id):
            await _finalize_cancel(job_id, state["partial"])
            return {"cancelled": True}
        raise  # process shutdown: job stays `processing`, the reaper re-queues it
    except Exception as exc:  # noqa: BLE001
        logger.exception("job %s crashed", job_id)
        async with SessionLocal() as session:
            row = await session.get(IngestionJob, job_id)
            if row is not None and row.status not in SETTLED_JOB_STATUSES:
                row.status = JobStatus.failed.value
                row.error = str(exc)
                row.updated_at = utcnow()
                await session.commit()
        await bus.publish(job_id, {"type": "error", "text": str(exc)})
        return {"assistant_text": "", "error": str(exc), "failed": True}


async def request_job_cancel(session: Any, job: IngestionJob) -> IngestionJob:
    """Stop a queued/running job (Stop button, /stop in messengers). Safe to call repeatedly.

    The running task is cancelled first (its rollback frees database locks), then the state is persisted;
    a job that is still queued is skipped by workers because it is no longer `accepted`.
    """
    if job.status in SETTLED_JOB_STATUSES:
        return job
    from app.queue.runner import get_runner

    await get_runner().cancel(job.id)
    await asyncio.sleep(0)
    await session.refresh(job)
    if job.status not in SETTLED_JOB_STATUSES:
        job.status = JobStatus.cancelled.value
        job.updated_at = utcnow()
        await session.commit()
    return job


async def _is_cancelled(job_id: str) -> bool:
    async with SessionLocal() as session:
        row = await session.get(IngestionJob, job_id)
        return row is not None and row.status == JobStatus.cancelled.value


async def _finalize_cancel(job_id: str, partial: str) -> None:
    """Record the interrupted turn (so history stays coherent) and tell subscribers."""
    text = (partial or "").strip()
    conv_id = None
    try:
        async with SessionLocal() as session:
            row = await session.get(IngestionJob, job_id)
            if row is not None:
                env = IngestionEnvelope(**(row.envelope or {}))
                conv = await get_or_create_conversation(
                    session, row.user_id, env.channel.value, conversation_id=env.conversation_id,
                    external_ref=env.external_ref,
                )
                if conv is not None:
                    conv_id = conv.id
                    await persist_turn(
                        session, row.user_id, conv.id, env.text or "(вложение)", (text + CANCEL_SUFFIX).strip()
                    )
                row.status = JobStatus.cancelled.value
                row.updated_at = utcnow()
                await session.commit()
    except Exception:  # noqa: BLE001
        logger.exception("could not persist cancelled turn for job %s", job_id)
    await bus.publish(job_id, {"type": "cancelled", "text": text, "conversation_id": conv_id})


async def _execute_job_inner(job_id: str, state: dict[str, Any]) -> dict:
    publish = bus.publisher(job_id)

    async def emit(event: dict[str, Any]) -> None:
        # keep the visible answer of the current LLM step (dropped on reset / after tool calls)
        t = event.get("type")
        if t == "token":
            state["partial"] += event.get("content") or ""
        elif t in ("reset", "tool_start"):
            state["partial"] = ""
        await publish(event)

    async with SessionLocal() as session:
        job = await session.get(IngestionJob, job_id)
        if job is None:
            return {}
        env = IngestionEnvelope(**(job.envelope or {}))
        out = await process_envelope(session, job.user_id, job, env, emit=emit)
        await session.commit()
        final_text = out.get("assistant_text") or ""
        if out.get("failed"):
            final_text = f"Ошибка: {out.get('error')}"
        pending = out.get("pending_facts") or []
        await bus.publish(
            job_id,
            {
                "type": "done" if not out.get("failed") else "error",
                "text": final_text,
                "conversation_id": (job.envelope or {}).get("conversation_id"),
                "pending_facts": pending,
                "status": job.status,
            },
        )
        await _channel_reply(env, final_text, pending)
        return out


async def _channel_reply(env: IngestionEnvelope, text: str, pending_facts: list[dict[str, Any]] | None = None) -> None:
    from app.channels.dispatch import send_reply  # local import: avoids cycle

    try:
        await send_reply(env, str(text), pending_facts or [])
    except Exception as exc:  # noqa: BLE001 — reply failures must not lose the job result
        logger.warning("%s reply failed: %s", env.channel.value, exc)
