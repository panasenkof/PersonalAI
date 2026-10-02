"""Durable channel delivery separate from agent execution."""
import sqlalchemy as sa
from alembic import op

revision = 'h9e4b0c2d003'
down_revision = 'g8d3a9b1c002'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('channel_deliveries',
        sa.Column('job_id', sa.String(36), sa.ForeignKey('ingestion_jobs.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('available_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('lease_token', sa.String(32), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('error', sa.Text(), nullable=True))
    op.create_index('ix_channel_deliveries_user_id', 'channel_deliveries', ['user_id'])
    op.create_index('ix_channel_deliveries_available_at', 'channel_deliveries', ['available_at'])


def downgrade():
    op.drop_table('channel_deliveries')
