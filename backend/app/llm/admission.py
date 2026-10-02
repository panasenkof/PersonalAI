"""Transactional per-user admission. Database limits survive restarts and Redis outages."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.ingestion.schemas import utcnow
from app.llm.limits import RateLimitExceeded
from app.models import IngestionJob, User, UserDailyUsage


async def reserve_request(session: AsyncSession, user_id: str, *, job: bool = True) -> None:
    """Reserve one LLM-bound request in the caller's transaction before creating its job.

    PostgreSQL NO KEY UPDATE serializes admission without conflicting with child FK inserts.
    SQLite uses a no-op write for serialization. Rollback releases the reservation; accepted
    requests keep it even when their later worker fails or the user cancels.
    """
    settings = get_settings()
    if settings.llm_requests_per_day <= 0 and (not job or settings.max_active_jobs_per_user <= 0):
        return
    connection = await session.connection()
    if connection.dialect.name == 'sqlite':
        await session.execute(update(User).where(User.id == user_id).values(token_version=User.token_version))
    else:
        await session.scalar(select(User.id).where(User.id == user_id).with_for_update(key_share=True))
    if job and settings.max_active_jobs_per_user > 0:
        active = await session.scalar(select(func.count()).select_from(IngestionJob).where(
            IngestionJob.user_id == user_id, IngestionJob.status.in_(['accepted', 'processing'])
        ))
        if (active or 0) >= settings.max_active_jobs_per_user:
            raise RateLimitExceeded(retry_after=10, reason='active_jobs_limit')
    if settings.llm_requests_per_day <= 0:
        return
    now = utcnow()
    period = now.date().isoformat()
    # Old counters need no personal payload and can be pruned under the same admission lock.
    await session.execute(delete(UserDailyUsage).where(
        UserDailyUsage.user_id == user_id, UserDailyUsage.period < (now - timedelta(days=30)).date().isoformat()
    ))
    row = await session.get(UserDailyUsage, (user_id, period))
    if row is None:
        row = UserDailyUsage(user_id=user_id, period=period, requests=0)
        session.add(row)
    if row.requests >= settings.llm_requests_per_day:
        midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        raise RateLimitExceeded(retry_after=max(1, int((midnight - now).total_seconds())), reason='daily_request_limit')
    row.requests += 1
    await session.flush()
