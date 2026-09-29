"""pgvector + trigram search, job attempts, roles/2FA, channels, extracted-fact confirmation

Revision ID: c3a1f0d2b7e4
Revises: ba2c8c4f76cd
Create Date: 2026-09-29 15:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op
from app.config import get_settings

# revision identifiers, used by Alembic.
revision: str = 'c3a1f0d2b7e4'
down_revision: Union[str, Sequence[str], None] = 'ba2c8c4f76cd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _is_pg() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    settings = get_settings()
    dims = int(settings.pgvector_dimensions)
    use_vec = _is_pg() and settings.use_pgvector

    # --- users: roles, 2FA, token versioning, new channels ---------------------------------
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("whatsapp_user_id", sa.String(length=64), nullable=True))
        b.add_column(sa.Column("discord_user_id", sa.String(length=64), nullable=True))
        b.add_column(sa.Column("role", sa.String(length=16), nullable=False, server_default="user"))
        b.add_column(sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()))
        b.add_column(sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"))
        b.add_column(sa.Column("totp_secret", sa.Text(), nullable=True))
        b.add_column(sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("recovery_codes", sa.JSON(), nullable=True))
        b.create_unique_constraint("uq_users_whatsapp_user_id", ["whatsapp_user_id"])
        b.create_unique_constraint("uq_users_discord_user_id", ["discord_user_id"])

    # --- conversations: external thread reference --------------------------------------------
    with op.batch_alter_table("conversations") as b:
        b.add_column(sa.Column("external_ref", sa.String(length=255), nullable=True))
        b.create_index("ix_conversations_external_ref", ["external_ref"])

    # --- jobs: attempt counter (persistent queue retries) ------------------------------------
    with op.batch_alter_table("ingestion_jobs") as b:
        b.add_column(sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_ingestion_jobs_status_updated", "ingestion_jobs", ["status", "updated_at"])

    # --- extracted facts: confirmation flow --------------------------------------------------
    with op.batch_alter_table("extracted_facts") as b:
        b.add_column(sa.Column("job_id", sa.String(length=36), nullable=True))
        b.add_column(sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True))
        b.create_index("ix_extracted_facts_job_id", ["job_id"])
        b.create_foreign_key(
            "fk_extracted_facts_job_id", "ingestion_jobs", ["job_id"], ["id"], ondelete="SET NULL"
        )

    # --- chunks: observation link + native vector column ------------------------------------
    with op.batch_alter_table("chunks") as b:
        b.add_column(sa.Column("observation_id", sa.String(length=36), nullable=True))
        b.create_index("ix_chunks_observation_id", ["observation_id"])
        b.create_foreign_key(
            "fk_chunks_observation_id", "observations", ["observation_id"], ["id"], ondelete="CASCADE"
        )
        if not use_vec:
            b.add_column(sa.Column("embedding_vec", sa.JSON(), nullable=True))

    if use_vec:
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
        op.execute(f"ALTER TABLE chunks ADD COLUMN embedding_vec vector({dims})")
        # Move existing JSON embeddings of the configured width into the native column.
        op.execute(
            f"""
            UPDATE chunks
               SET embedding_vec = embedding::text::vector, embedding = NULL
             WHERE embedding IS NOT NULL
               AND json_typeof(embedding::json) = 'array'
               AND json_array_length(embedding::json) = {dims}
            """
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_chunks_embedding_hnsw "
            "ON chunks USING hnsw (embedding_vec vector_cosine_ops)"
        )
    if _is_pg():
        op.execute(
            "DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; "
            "CREATE INDEX IF NOT EXISTS ix_chunks_text_trgm ON chunks USING gin (text gin_trgm_ops); "
            "EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm unavailable'; END $$"
        )


def downgrade() -> None:
    if _is_pg():
        op.execute("DROP INDEX IF EXISTS ix_chunks_text_trgm")
        op.execute("DROP INDEX IF EXISTS ix_chunks_embedding_hnsw")
    with op.batch_alter_table("chunks") as b:
        b.drop_constraint("fk_chunks_observation_id", type_="foreignkey")
        b.drop_index("ix_chunks_observation_id")
        b.drop_column("observation_id")
        b.drop_column("embedding_vec")
    with op.batch_alter_table("extracted_facts") as b:
        b.drop_constraint("fk_extracted_facts_job_id", type_="foreignkey")
        b.drop_index("ix_extracted_facts_job_id")
        b.drop_column("resolved_at")
        b.drop_column("job_id")
    op.drop_index("ix_ingestion_jobs_status_updated", table_name="ingestion_jobs")
    with op.batch_alter_table("ingestion_jobs") as b:
        b.drop_column("attempts")
    with op.batch_alter_table("conversations") as b:
        b.drop_index("ix_conversations_external_ref")
        b.drop_column("external_ref")
    with op.batch_alter_table("users") as b:
        b.drop_constraint("uq_users_discord_user_id", type_="unique")
        b.drop_constraint("uq_users_whatsapp_user_id", type_="unique")
        for col in (
            "recovery_codes", "totp_enabled", "totp_secret", "token_version",
            "is_active", "role", "discord_user_id", "whatsapp_user_id",
        ):
            b.drop_column(col)
