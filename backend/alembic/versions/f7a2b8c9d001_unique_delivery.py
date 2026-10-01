"""Atomic webhook delivery deduplication.

Revision ID: f7a2b8c9d001
Revises: e5c7d9b2a1f4
"""
import hashlib

import sqlalchemy as sa
from alembic import op

revision = "f7a2b8c9d001"
down_revision = "e5c7d9b2a1f4"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("ingestion_jobs") as b:
        b.add_column(sa.Column("delivery_key", sa.String(64), nullable=True))
        b.create_unique_constraint("uq_job_delivery", ["user_id", "delivery_key"])
    # Keep old duplicates for audit/history; only the earliest row claims the key.
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, user_id, correlation_id FROM ingestion_jobs WHERE correlation_id IS NOT NULL ORDER BY created_at, id")).all()
    seen = set()
    channels = {"tg": "telegram", "slack": "slack", "wa": "whatsapp", "discord": "discord"}
    for jid, uid, corr in rows:
        channel = channels.get(corr.split(":", 1)[0])
        if channel is None:
            continue
        key = hashlib.sha256(f"{channel}:{corr}".encode()).hexdigest()
        if (uid, key) in seen:
            continue
        seen.add((uid, key))
        bind.execute(sa.text("UPDATE ingestion_jobs SET delivery_key=:key WHERE id=:id"), {"key": key, "id": jid})


def downgrade():
    with op.batch_alter_table("ingestion_jobs") as b:
        b.drop_constraint("uq_job_delivery", type_="unique")
        b.drop_column("delivery_key")
