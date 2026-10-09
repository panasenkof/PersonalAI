"""Upgrade a populated legacy database; CI supplies a disposable Postgres database."""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import JSON, bindparam, inspect, text
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


@pytest.mark.parametrize("previous", ["i0f5c1d3e004", "j0f5c1d3e004"])
def test_upgrade_max_and_daily_usage_branches_converge(tmp_path, previous):
    url = f"sqlite+aiosqlite:///{tmp_path / 'merge.db'}"
    env = {**os.environ, "DATABASE_URL": url, "POSTGRES_HOST": ""}
    backend = Path(__file__).resolve().parents[1]
    for revision in (previous, "head"):
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", revision], cwd=backend, env=env, check=True, capture_output=True)
    async def verify():
        engine = create_async_engine(url)
        async with engine.connect() as c:
            versions = (await c.execute(text("SELECT version_num FROM alembic_version"))).scalars().all()
            assert versions == ["m2c7e4f6a008"]
            columns = await c.run_sync(lambda conn: inspect(conn).get_columns("users"))
            assert "max_user_id" in {column["name"] for column in columns}
            tables = await c.run_sync(lambda conn: inspect(conn).get_table_names())
            assert "user_daily_usage" in tables
        await engine.dispose()
    asyncio.run(verify())



@pytest.mark.parametrize("dialect", ["sqlite", "postgres"])
def test_memory_v2_migration_preserves_legacy_rows(tmp_path, dialect):
    """Do not rewrite old payloads, assume provenance or invent validity dates."""
    url = os.environ.get("MIGRATION_TEST_DATABASE_URL") if dialect == "postgres" else f"sqlite+aiosqlite:///{tmp_path / 'memory_upgrade.db'}"
    if not url:
        pytest.skip("requires dedicated MIGRATION_TEST_DATABASE_URL")
    env = {**os.environ, "DATABASE_URL": url, "POSTGRES_HOST": ""}
    backend = Path(__file__).resolve().parents[1]

    def migrate(revision):
        subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", revision],
            cwd=backend, env=env, check=True, capture_output=True,
        )

    migrate("k1a6d2e4f005")

    async def seed():
        engine = create_async_engine(url)
        async with engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO users (id,email,password_hash,role,is_active,token_version,created_at) "
                "VALUES ('memory-user','memory-upgrade@example.com','unused','user',true,0,CURRENT_TIMESTAMP)"
            ))
            await conn.execute(text(
                "INSERT INTO collections (id,user_id,name,slug) "
                "VALUES ('memory-collection','memory-user','Garage','garage')"
            ))
            await conn.execute(
                text("""INSERT INTO entities (id,user_id,collection_id,domain,schema_version,payload,created_at)
                    VALUES ('memory-entity','memory-user','memory-collection','automotive','1',
                    :payload,CURRENT_TIMESTAMP)""").bindparams(bindparam("payload", type_=JSON())),
                {"payload": {"type": "vehicle", "make": "Toyota"}},
            )
            await conn.execute(
                text("""INSERT INTO observations (id,user_id,entity_id,occurred_at,kind,payload,created_at)
                    VALUES ('memory-observation','memory-user','memory-entity',CURRENT_TIMESTAMP,
                    'service_event',:payload,CURRENT_TIMESTAMP)""").bindparams(bindparam("payload", type_=JSON())),
                {"payload": {"notes": "old receipt", "odometer_km": 123}},
            )
        await engine.dispose()

    asyncio.run(seed())
    migrate("head")

    async def verify():
        engine = create_async_engine(url)
        async with engine.connect() as conn:
            collections = await conn.run_sync(lambda c: {v["name"] for v in inspect(c).get_columns("collections")})
            entities = await conn.run_sync(lambda c: {v["name"] for v in inspect(c).get_columns("entities")})
            observations = await conn.run_sync(lambda c: {v["name"] for v in inspect(c).get_columns("observations")})
            assert {"description", "sensitivity"} <= collections
            assert {"title", "record_status", "sensitivity", "valid_from", "valid_until", "source_kind", "source_ref", "updated_at"} <= entities
            assert {"sensitivity", "valid_from", "valid_until", "source_kind", "source_ref", "confidence"} <= observations
            collection = (await conn.execute(text(
                "SELECT name, slug, sensitivity, description FROM collections WHERE id='memory-collection'"
            ))).one()
            assert tuple(collection) == ("Garage", "garage", "unclassified", None)
            entity = (await conn.execute(text(
                "SELECT domain, payload, sensitivity, record_status, valid_from, source_ref "
                "FROM entities WHERE id='memory-entity'"
            ))).one()
            assert entity.domain == "automotive"
            assert "Toyota" in str(entity.payload)
            assert entity.sensitivity == "inherit" and entity.record_status == "active"
            assert entity.valid_from is None and entity.source_ref is None
            observation = (await conn.execute(text(
                "SELECT kind,payload,sensitivity,confidence,source_kind FROM observations "
                "WHERE id='memory-observation'"
            ))).one()
            assert observation.kind == "service_event" and '"old receipt"' in str(observation.payload)
            assert observation.sensitivity == "inherit"
            assert observation.confidence is None and observation.source_kind is None
        await engine.dispose()

    asyncio.run(verify())
