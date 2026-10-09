"""Explicit owner consent before cloud memory egress.

Revision ID: p4e9a6b8c010
Revises: n3d8f5a7b009
"""
from alembic import op
import sqlalchemy as sa

revision = "p4e9a6b8c010"
down_revision = "n3d8f5a7b009"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("collections") as batch:
        batch.add_column(sa.Column("allow_cloud_llm", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("allow_remote_embeddings", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("llm_settings") as batch:
        batch.add_column(sa.Column("cloud_history_access", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    with op.batch_alter_table("llm_settings") as batch:
        batch.drop_column("cloud_history_access")
    with op.batch_alter_table("collections") as batch:
        batch.drop_column("allow_remote_embeddings")
        batch.drop_column("allow_cloud_llm")
