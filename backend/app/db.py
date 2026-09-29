import logging
from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import get_settings
from app.models import PGVECTOR_AVAILABLE, Base

logger = logging.getLogger(__name__)

settings = get_settings()

_is_pg = settings.database_url.startswith("postgresql")
_pg_args: dict = {"poolclass": NullPool} if settings.db_null_pool else {"pool_pre_ping": True, "pool_size": 10, "max_overflow": 20}
engine = create_async_engine(settings.database_url, echo=False, **(_pg_args if _is_pg else {}))
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

USE_PGVECTOR = _is_pg and PGVECTOR_AVAILABLE

async def init_db() -> None:
    if USE_PGVECTOR:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
