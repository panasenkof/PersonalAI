"""Entity relationships and versioned memory corrections.

Revision ID: n3d8f5a7b009
Revises: m2c7e4f6a008
"""
import sqlalchemy as sa
from alembic import op

revision = "n3d8f5a7b009"
down_revision = "m2c7e4f6a008"
branch_labels = None
depends_on = None


def upgrade():
    # Existing records keep their IDs, payload and event dates; version 1 is an
    # implicit baseline, not a fabricated historical snapshot.
    with op.batch_alter_table("entities") as batch:
        batch.add_column(sa.Column("record_version", sa.Integer(), nullable=False, server_default="1"))
    with op.batch_alter_table("observations") as batch:
        batch.add_column(sa.Column("record_version", sa.Integer(), nullable=False, server_default="1"))

    op.create_table(
        "memory_relations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_entity_id", sa.String(36), sa.ForeignKey("entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_entity_id", sa.String(36), sa.ForeignKey("entities.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.Column("source_kind", sa.String(32), nullable=True),
        sa.Column("source_ref", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_entity_id", "target_entity_id", "kind", name="uq_memory_relation_edge"),
        sa.CheckConstraint("source_entity_id <> target_entity_id", name="ck_memory_relation_no_self"),
    )
    op.create_index("ix_memory_relations_user_id", "memory_relations", ["user_id"])
    op.create_index("ix_memory_relations_user_source", "memory_relations", ["user_id", "source_entity_id"])
    op.create_index("ix_memory_relations_user_target", "memory_relations", ["user_id", "target_entity_id"])

    op.create_table(
        "memory_revisions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("entity_id", sa.String(36), sa.ForeignKey("entities.id", ondelete="CASCADE"), nullable=True),
        sa.Column("observation_id", sa.String(36), sa.ForeignKey("observations.id", ondelete="CASCADE"), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(512), nullable=False),
        sa.Column("actor_kind", sa.String(32), nullable=False),
        sa.Column("before_state", sa.JSON(), nullable=False),
        sa.Column("after_state", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("entity_id", "version", name="uq_memory_revision_entity_version"),
        sa.UniqueConstraint("observation_id", "version", name="uq_memory_revision_observation_version"),
        sa.CheckConstraint(
            "(entity_id IS NOT NULL AND observation_id IS NULL) OR "
            "(entity_id IS NULL AND observation_id IS NOT NULL)",
            name="ck_memory_revision_one_subject",
        ),
    )
    op.create_index("ix_memory_revisions_user_id", "memory_revisions", ["user_id"])
    op.create_index("ix_memory_revisions_user_entity", "memory_revisions", ["user_id", "entity_id"])
    op.create_index("ix_memory_revisions_user_observation", "memory_revisions", ["user_id", "observation_id"])


def downgrade():
    op.drop_table("memory_revisions")
    op.drop_table("memory_relations")
    with op.batch_alter_table("observations") as batch:
        batch.drop_column("record_version")
    with op.batch_alter_table("entities") as batch:
        batch.drop_column("record_version")
