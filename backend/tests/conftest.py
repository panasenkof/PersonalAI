from __future__ import annotations

import os
import uuid

import pytest
from starlette.testclient import TestClient

# Absolute paths: pytest must hit the same fresh test DB from any cwd.
# (create_all cannot alter existing columns, so a stale DB would break tests.)
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_TEST_DB = os.path.join(_BACKEND, "test_pia_agent.db")
_TEST_BLOBS = os.path.join(_BACKEND, "test_blobs")

if os.path.exists(_TEST_DB):
    os.remove(_TEST_DB)

os.environ.setdefault("JWT_SECRET", "test-jwt-secret-test-jwt-secret-12")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TEST_DB}")
os.environ.setdefault("BLOB_STORAGE_DIR", _TEST_BLOBS)

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
