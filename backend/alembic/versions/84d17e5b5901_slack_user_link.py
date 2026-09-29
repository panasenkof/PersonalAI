"""slack user link

Revision ID: 84d17e5b5901
Revises: 095941a20484
Create Date: 2026-09-29 11:59:54.502327

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '84d17e5b5901'
down_revision: Union[str, Sequence[str], None] = '095941a20484'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    batch_alter_table: plain ALTER ... ADD CONSTRAINT is not supported on SQLite;
    batch mode issues a table rebuild there and a normal ALTER on Postgres.
    """
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(sa.Column("slack_user_id", sa.String(length=64), nullable=True))
        batch_op.create_unique_constraint("uq_users_slack_user_id", ["slack_user_id"])


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_constraint("uq_users_slack_user_id", type_="unique")
        batch_op.drop_column("slack_user_id")
