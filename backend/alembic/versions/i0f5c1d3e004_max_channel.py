"""Add MAX account link.

Revision ID: i0f5c1d3e004
Revises: h9e4b0c2d003
"""
import sqlalchemy as sa
from alembic import op

revision = "i0f5c1d3e004"
down_revision = "h9e4b0c2d003"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("max_user_id", sa.String(64), nullable=True))
        b.create_unique_constraint("uq_users_max_user_id", ["max_user_id"])


def downgrade():
    with op.batch_alter_table("users") as b:
        b.drop_constraint("uq_users_max_user_id", type_="unique")
        b.drop_column("max_user_id")
