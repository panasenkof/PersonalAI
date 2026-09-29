from __future__ import annotations

import os
import uuid

import pytest
from starlette.testclient import TestClient

# Start from a clean slate: create_all cannot alter existing columns, so a stale
# test DB from a previous run would break tests after schema changes.
for _db_file in ("./test_pia_agent.db",):
    if os.path.exists(_db_file):
        os.remove(_db_file)

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-test-jwt-secret-12")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test_pia_agent.db")
os.environ.setdefault("BLOB_STORAGE_DIR", "./test_blobs")

from app.db import init_db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _init_tables():
    import asyncio

    asyncio.run(init_db())


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def random_email() -> str:
    return f"u{uuid.uuid4().hex[:10]}@example.com"
