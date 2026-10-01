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
engine = create_async_engine(settings.database_url, echo=False, **(_pg_args if _is_pg else ({"poolclass": NullPool} if settings.db_null_pool else {})))
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

USE_PGVECTOR = _is_pg and PGVECTOR_AVAILABLE

_INIT_LOCK_ID = 727_274_101  # arbitrary constant: serialises schema creation across replicas/workers


async def init_db() -> None:
    """Create missing tables/extensions. Every API replica and worker calls this at startup, so on
    Postgres the whole thing runs under an advisory lock (concurrent CREATE TABLE/EXTENSION races)."""
    async with engine.begin() as conn:
        if settings.is_production:
            from pathlib import Path

            from alembic.config import Config
            from alembic.migration import MigrationContext
            from alembic.script import ScriptDirectory

            base = Path(__file__).resolve().parents[1]
            config = Config(str(base / "alembic.ini"))
            config.set_main_option("script_location", str(base / "alembic"))
            expected = set(ScriptDirectory.from_config(config).get_heads())
            actual = await conn.run_sync(lambda c: set(MigrationContext.configure(c).get_current_heads()))
            if actual != expected:
                raise RuntimeError("Database migrations required: run alembic upgrade head before starting services")
            return
        if _is_pg:
            await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _INIT_LOCK_ID})
        if USE_PGVECTOR:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
