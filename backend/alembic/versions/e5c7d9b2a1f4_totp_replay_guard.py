"""users.totp_last_step: reject replay of an already used TOTP code

Revision ID: e5c7d9b2a1f4
Revises: c3a1f0d2b7e4
Create Date: 2026-09-29 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "e5c7d9b2a1f4"
down_revision: Union[str, Sequence[str], None] = "c3a1f0d2b7e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("totp_last_step", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.drop_column("totp_last_step")
