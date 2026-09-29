"""Real Postgres + pgvector scenario (HNSW index, hybrid search). Skipped when `pgserver` is absent.

CI additionally runs the whole suite against a pgvector service container (see .github/workflows/ci.yml).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

import pytest

pgserver = pytest.importorskip("pgserver")

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_pgvector_scenario_on_real_postgres() -> None:
    data_dir = tempfile.mkdtemp(prefix="pia_pg_", dir="/tmp")
    server = pgserver.get_server(data_dir, cleanup_mode="stop")
    try:
        server.psql("create database pia_t;")
        env = {
            **os.environ,
            "DATABASE_URL": f"postgresql+asyncpg://postgres:@/pia_t?host={data_dir}",
            "JWT_SECRET": "x" * 32,
        }
        proc = subprocess.run(
            [sys.executable, "-m", "tests.pg.scenario_pgvector"],
            cwd=BACKEND, env=env, capture_output=True, text=True, timeout=180,
        )
        assert proc.returncode == 0 and "OK" in proc.stdout, proc.stdout[-2000:] + proc.stderr[-3000:]
    finally:
        server.cleanup()
        shutil.rmtree(data_dir, ignore_errors=True)
