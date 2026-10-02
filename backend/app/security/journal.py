"""Cross-platform exclusive append to the durable account-deletion journal."""
from __future__ import annotations

import os
from importlib import import_module
from pathlib import Path


def append_deletion(path: Path, user_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as file:
        os.chmod(path, 0o600)
        if os.name == 'nt':
            msvcrt = import_module("msvcrt")

            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(file, fcntl.LOCK_EX)
        try:
            file.seek(0, os.SEEK_END)
            file.write((user_id + '\n').encode('utf-8'))
            file.flush()
            os.fsync(file.fileno())
        finally:
            if os.name == 'nt':
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(file, fcntl.LOCK_UN)
