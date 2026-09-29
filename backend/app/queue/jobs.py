from __future__ import annotations

import logging

from app.db import SessionLocal
from app.ingestion.pipeline import process_envelope
from app.ingestion.schemas import IngestionEnvelope, utcnow
from app.models import IngestionJob, JobStatus
from app.queue.events import bus

logger = logging.getLogger(__name__)


async def execute_job(job_id: str) -> dict:
    """Process an ingestion job outside the HTTP request cycle.

    Used by the queue path: opens its own DB session, streams token/tool events
    on the EventBus for SSE subscribers, then dispatches the channel reply.
    Any crash outside process_envelope's own handler marks the job failed so
    SSE subscribers and pollers terminate instead of hanging forever.
    """
    try:
        return await _execute_job_inner(job_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("job %s crashed", job_id)
        async with SessionLocal() as session:
            job = await session.get(IngestionJob, job_id)
            if job is not None and job.status not in (
                JobStatus.completed.value,
                JobStatus.failed.value,
            ):
                job.status = JobStatus.failed.value
                job.error = str(exc)
                job.updated_at = utcnow()
                await session.commit()
        await bus.publish(job_id, {"type": "error", "text": str(exc)})
        return {"assistant_text": "", "error": str(exc), "failed": True}


async def _execute_job_inner(job_id: str) -> dict:
    async with SessionLocal() as session:
        job = await session.get(IngestionJob, job_id)
        if job is None:
            logger.error("job %s not found", job_id)
            return {}
        env = IngestionEnvelope(**(job.envelope or {}))
        out = await process_envelope(session, job.user_id, job, env, emit=bus.publisher(job_id))
        await session.commit()
        final_text = out.get("assistant_text") or ""
        if out.get("failed"):
            final_text = f"Ошибка: {out.get('error')}"
        await bus.publish(
            job_id,
            {
                "type": "done" if not out.get("failed") else "error",
                "text": final_text,
                "conversation_id": (job.envelope or {}).get("conversation_id"),
            },
        )
        await _channel_reply(env, final_text)
        return out


async def _channel_reply(env: IngestionEnvelope, text: str) -> None:
    if env.channel.value != "telegram":
        return
    chat_id = (env.channel_meta or {}).get("chat_id")
    if not chat_id:
        return
    from app.channels.telegram import send_telegram_message  # local import: avoids cycle

    try:
        await send_telegram_message(chat_id=int(chat_id), text=str(text)[:4000])
    except Exception as exc:  # noqa: BLE001 — reply failures must not lose the job result
        logger.warning("telegram reply failed: %s", exc)
