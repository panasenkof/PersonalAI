"""Owner consent for media extraction, speech, MCP and reminders.

Revision ID: q5f0b7c9d011
Revises: p4e9a6b8c010
"""
from alembic import op
import sqlalchemy as sa

revision = "q5f0b7c9d011"
down_revision = "p4e9a6b8c010"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("collections") as batch:
        batch.add_column(sa.Column("allow_remote_extraction", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("allow_messenger_reminders", sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table("llm_settings") as batch:
        batch.add_column(sa.Column("allow_remote_stt", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("allow_mcp_access", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    with op.batch_alter_table("llm_settings") as batch:
        batch.drop_column("allow_mcp_access")
        batch.drop_column("allow_remote_stt")
    with op.batch_alter_table("collections") as batch:
        batch.drop_column("allow_messenger_reminders")
        batch.drop_column("allow_remote_extraction")
