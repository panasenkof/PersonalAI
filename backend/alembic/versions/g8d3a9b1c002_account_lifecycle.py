"""Account verification, recovery and durable cleanup.

Revision ID: g8d3a9b1c002
Revises: a8b3c9d002
"""
import sqlalchemy as sa
from alembic import op

revision = 'g8d3a9b1c002'
down_revision = 'a8b3c9d002'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users') as b:
        b.add_column(sa.Column('email_verified', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table('email_actions',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('purpose', sa.String(16), nullable=False),
        sa.Column('token_version', sa.Integer(), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True)))
    op.create_index('ix_email_actions_user_id', 'email_actions', ['user_id'])
    op.create_table('mail_outbox',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.String(36), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('recipient', sa.String(255), nullable=False),
        sa.Column('subject', sa.String(255), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('attempts', sa.Integer(), nullable=False),
        sa.Column('available_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False))
    op.create_index('ix_mail_outbox_user_id', 'mail_outbox', ['user_id'])
    op.create_table('blob_deletions',
        sa.Column('storage_key', sa.String(512), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False))


def downgrade():
    op.drop_table('blob_deletions')
    op.drop_table('mail_outbox')
    op.drop_table('email_actions')
    with op.batch_alter_table('users') as b:
        b.drop_column('email_verified')
