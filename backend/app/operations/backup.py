"""Encrypted offline backups. Restore into a NEW directory, never overwrite a live installation."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from cryptography.fernet import Fernet

MAX_BYTES = 1024 * 1024 * 1024  # in-memory encrypted archive: use dedicated tooling above 1 GiB


def create_backup(database: Path, blobs: Path, output: Path, key: str, kind: str = 'postgres') -> None:
    cipher = Fernet(key.encode())
    if kind not in {'postgres', 'sqlite'}:
        raise ValueError('Unsupported database format')
    files = [('database.dump', database)]
    for path in sorted(blobs.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlinks are not allowed in blob storage')
        if path.is_file():
            files.append(('blobs/' + path.relative_to(blobs).as_posix(), path))
    if sum(path.stat().st_size for _, path in files) > MAX_BYTES:
        raise ValueError('Backup exceeds 1 GiB; use dedicated streaming backup tooling')
    buffer = io.BytesIO()
    hashes = {}
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, path in files:
            content = path.read_bytes()
            hashes[name] = hashlib.sha256(content).hexdigest()
            archive.writestr(name, content)
        archive.writestr('manifest.json', json.dumps({'version': 1, 'database': kind, 'created_at': datetime.now(timezone.utc).isoformat(), 'sha256': hashes}))
    if len(buffer.getvalue()) > MAX_BYTES:
        raise ValueError('Backup exceeds 1 GiB')
    output.parent.mkdir(parents=True, exist_ok=True)
    # O_EXCL makes timestamp collisions or accidental overwrites fail safely.
    with output.open('xb') as file:
        os.chmod(output, 0o600)
        file.write(cipher.encrypt(buffer.getvalue()))
        file.flush()
        os.fsync(file.fileno())


def restore_backup(backup: Path, destination: Path, key: str) -> str:
    if destination.exists():
        raise ValueError('Restore destination must not exist')
    if backup.stat().st_size > MAX_BYTES * 2:
        raise ValueError('Backup exceeds size limit')
    plaintext = Fernet(key.encode()).decrypt(backup.read_bytes())
    with zipfile.ZipFile(io.BytesIO(plaintext)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names) or sum(entry.file_size for entry in entries) > MAX_BYTES:
            raise ValueError('Invalid archive or size limit exceeded')
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe backup path')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest['version'] != 1 or manifest['database'] not in {'postgres', 'sqlite'}:
            raise ValueError('Unsupported backup format')
        hashes = manifest['sha256']
        if set(hashes) != set(names) - {'manifest.json'} or 'database.dump' not in hashes:
            raise ValueError('Invalid backup manifest')
        for name, expected in hashes.items():
            if name != 'database.dump' and not name.startswith('blobs/'):
                raise ValueError('Unexpected backup file')
            if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                raise ValueError('Backup checksum failed')
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
            staging = Path(temporary) / 'restore'
            staging.mkdir(mode=0o700)
            for name in hashes:
                path = staging / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(name))
                path.chmod(0o600)
            staging.rename(destination)
    return str(manifest['database'])


def sqlite_snapshot(source: Path, target: Path) -> None:
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as original, sqlite3.connect(target) as snapshot:
        original.backup(snapshot)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'restore'])
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--database', type=Path)
    parser.add_argument('--blobs', type=Path)
    parser.add_argument('--kind', choices=['postgres', 'sqlite'], default='postgres')
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--writers-stopped', action='store_true')
    args = parser.parse_args()
    key = os.environ.get('BACKUP_ENCRYPTION_KEY', '')
    if not key:
        parser.error('Set BACKUP_ENCRYPTION_KEY separately from application encryption keys')
    if args.operation == 'create':
        if not args.writers_stopped or not args.database or not args.blobs:
            parser.error('Stop all API/worker writers, then provide --writers-stopped --database --blobs')
        if args.kind == 'sqlite':
            with tempfile.TemporaryDirectory() as temp:
                snapshot = Path(temp) / 'snapshot.db'
                sqlite_snapshot(args.database, snapshot)
                create_backup(snapshot, args.blobs, args.archive, key, args.kind)
        else:
            create_backup(args.database, args.blobs, args.archive, key, args.kind)
        print('Encrypted backup created. Keep keys and the deletion journal separately.')
    else:
        if not args.destination:
            parser.error('Provide a new --destination directory')
        kind = restore_backup(args.archive, args.destination, key)
        print(f'Validated {kind} snapshot restored to an isolated directory. Import the database, apply the CURRENT deletion journal, then verify /ready and private data before serving traffic.')


if __name__ == '__main__':
    main()
