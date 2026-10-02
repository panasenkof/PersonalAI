"""Upgrade a populated legacy database; CI supplies a disposable Postgres database."""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


@pytest.mark.parametrize("dialect", ["sqlite", "postgres"])
def test_upgrade_preserves_existing_jobs_and_claims_one_delivery(tmp_path, dialect):
    url = os.environ.get("MIGRATION_TEST_DATABASE_URL") if dialect == "postgres" else f"sqlite+aiosqlite:///{tmp_path / 'upgrade.db'}"
    if not url:
        pytest.skip("requires dedicated MIGRATION_TEST_DATABASE_URL")
    env = {**os.environ, "DATABASE_URL": url, "POSTGRES_HOST": ""}
    backend = Path(__file__).resolve().parents[1]
    def migrate(revision):
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", revision], cwd=backend, env=env, check=True, capture_output=True)
    migrate("e5c7d9b2a1f4")
    async def seed():
        engine = create_async_engine(url)
        async with engine.begin() as c:
            await c.execute(text("INSERT INTO users (id,email,password_hash,role,is_active,token_version,created_at) VALUES ('upgrade-user','upgrade@example.com','unused','user',true,0,CURRENT_TIMESTAMP)"))
            for jid in ("upgrade-job-1", "upgrade-job-2"):
                await c.execute(text("INSERT INTO ingestion_jobs (id,user_id,status,correlation_id,envelope,attempts,created_at,updated_at) VALUES (:id,'upgrade-user','completed','tg:upgrade','{}',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"), {"id": jid})
        await engine.dispose()
    asyncio.run(seed())
    migrate("head")
    async def verify():
        engine = create_async_engine(url)
        async with engine.connect() as c:
            assert (await c.execute(text("SELECT count(*) FROM ingestion_jobs WHERE id LIKE 'upgrade-job-%'"))).scalar() == 2
            assert (await c.execute(text("SELECT count(delivery_key) FROM ingestion_jobs WHERE id LIKE 'upgrade-job-%'"))).scalar() == 1
            columns = await c.run_sync(lambda conn: inspect(conn).get_columns("chunks"))
            assert "embedding_space" in {column["name"] for column in columns}
            indexes = await c.run_sync(lambda conn: inspect(conn).get_indexes("ingestion_jobs"))
            assert "ix_ingestion_jobs_status_updated" in {index["name"] for index in indexes}
            delivery_columns = await c.run_sync(lambda conn: inspect(conn).get_columns("channel_deliveries"))
            assert {"job_id", "user_id", "attempts", "lease_until", "lease_token", "sent_at"} <= {column["name"] for column in delivery_columns}
            user_columns = await c.run_sync(lambda conn: inspect(conn).get_columns("users"))
            assert "max_user_id" in {column["name"] for column in user_columns}
            assert (await c.execute(text("SELECT max_user_id FROM users WHERE id='upgrade-user'"))).scalar() is None
        await engine.dispose()
    asyncio.run(verify())
