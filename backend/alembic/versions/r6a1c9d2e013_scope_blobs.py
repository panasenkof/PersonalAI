"""Explicit per-collection MCP grant and blob provenance.

Revision ID: r6a1c9d2e013
Revises: q5f0b7c9d011
"""
from alembic import op
import sqlalchemy as sa

revision = "r6a1c9d2e013"
down_revision = "q5f0b7c9d011"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("collections") as batch:
        batch.add_column(sa.Column("allow_mcp_access", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("blobs") as batch:
        batch.add_column(sa.Column("collection_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("sensitivity", sa.String(16), nullable=False, server_default="unclassified"))
        batch.create_foreign_key("fk_blob_collection", "collections", ["collection_id"], ["id"], ondelete="SET NULL")


def downgrade():
    with op.batch_alter_table("blobs") as batch:
        batch.drop_constraint("fk_blob_collection", type_="foreignkey")
        batch.drop_column("sensitivity")
        batch.drop_column("collection_id")
    with op.batch_alter_table("collections") as batch:
        batch.drop_column("allow_mcp_access")
