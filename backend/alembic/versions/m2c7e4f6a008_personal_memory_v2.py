"""Add optional personal-memory metadata without rewriting historical payloads.

Revision ID: m2c7e4f6a008
Revises: k1a6d2e4f005
"""
from alembic import op
import sqlalchemy as sa

revision = "m2c7e4f6a008"
down_revision = "k1a6d2e4f005"
branch_labels = None
depends_on = None


def upgrade():
    # Legacy collections are deliberately unclassified; do not silently treat
    # health, finance or other historical data as safe for cloud processing.
    with op.batch_alter_table("collections") as batch:
        batch.add_column(sa.Column("description", sa.Text(), nullable=True))
        batch.add_column(sa.Column("sensitivity", sa.String(16), nullable=False,
                                   server_default="unclassified"))
    with op.batch_alter_table("entities") as batch:
        batch.add_column(sa.Column("title", sa.String(255), nullable=True))
        batch.add_column(sa.Column("record_status", sa.String(16), nullable=False,
                                   server_default="active"))
        batch.add_column(sa.Column("sensitivity", sa.String(16), nullable=False,
                                   server_default="inherit"))
        batch.add_column(sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("source_kind", sa.String(32), nullable=True))
        batch.add_column(sa.Column("source_ref", sa.String(512), nullable=True))
        batch.add_column(sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("observations") as batch:
        batch.add_column(sa.Column("sensitivity", sa.String(16), nullable=False,
                                   server_default="inherit"))
        batch.add_column(sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("source_kind", sa.String(32), nullable=True))
        batch.add_column(sa.Column("source_ref", sa.String(512), nullable=True))
        batch.add_column(sa.Column("confidence", sa.Float(), nullable=True))


def downgrade():
    # Downgrading removes only v2 metadata; existing v1 records are retained.
    with op.batch_alter_table("observations") as batch:
        for name in ("confidence", "source_ref", "source_kind",
                     "valid_until", "valid_from", "sensitivity"):
            batch.drop_column(name)
    with op.batch_alter_table("entities") as batch:
        for name in ("updated_at", "source_ref", "source_kind", "valid_until",
                     "valid_from", "sensitivity", "record_status", "title"):
            batch.drop_column(name)
    with op.batch_alter_table("collections") as batch:
        batch.drop_column("sensitivity")
        batch.drop_column("description")
