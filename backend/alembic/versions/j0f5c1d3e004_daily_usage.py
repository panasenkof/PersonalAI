"""Durable daily request quotas across API replicas."""
import sqlalchemy as sa
from alembic import op

revision = 'j0f5c1d3e004'
down_revision = 'h9e4b0c2d003'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('user_daily_usage',
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('period', sa.String(10), primary_key=True),
        sa.Column('requests', sa.Integer(), nullable=False, server_default='0'))


def downgrade():
    op.drop_table('user_daily_usage')
