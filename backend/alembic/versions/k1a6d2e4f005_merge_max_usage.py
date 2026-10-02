"""Merge MAX account links and daily usage migrations.

Both upgrade paths remain valid for installations already on either branch.
"""
revision = "k1a6d2e4f005"
down_revision = ("i0f5c1d3e004", "j0f5c1d3e004")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
