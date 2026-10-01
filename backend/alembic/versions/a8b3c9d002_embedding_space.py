"""Track embedding compatibility; legacy vectors stay text-searchable until rebuilt."""
import sqlalchemy as sa
from alembic import op

revision = "a8b3c9d002"
down_revision = "f7a2b8c9d001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("chunks", sa.Column("embedding_space", sa.String(64), nullable=True))


def downgrade():
    with op.batch_alter_table("chunks") as batch:
        batch.drop_column("embedding_space")
