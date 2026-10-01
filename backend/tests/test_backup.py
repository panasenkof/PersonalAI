import io
import json
import sqlite3
import zipfile

import pytest
from cryptography.fernet import Fernet, InvalidToken

from app.operations.backup import create_backup, restore_backup, sqlite_snapshot


def test_encrypted_backup_restore_real_sqlite_and_files(tmp_path):
    source = tmp_path / 'original.db'
    with sqlite3.connect(source) as db:
        db.execute('CREATE TABLE private_data (content TEXT)')
        db.execute('INSERT INTO private_data VALUES (?)', ('private conversation',))
    blobs = tmp_path / 'files'
    (blobs / 'ab').mkdir(parents=True)
    (blobs / 'ab' / 'file.bin').write_bytes(b'private original file')
    snapshot = tmp_path / 'snapshot.db'
    sqlite_snapshot(source, snapshot)
    key = Fernet.generate_key().decode()
    backup = tmp_path / 'snapshot.fernet'
    create_backup(snapshot, blobs, backup, key, 'sqlite')
    assert b'private' not in backup.read_bytes()
    destination = tmp_path / 'restored'
    assert restore_backup(backup, destination, key) == 'sqlite'
    with sqlite3.connect(destination / 'database.dump') as db:
        assert db.execute('SELECT content FROM private_data').fetchone() == ('private conversation',)
    assert (destination / 'blobs/ab/file.bin').read_bytes() == b'private original file'
    with pytest.raises(ValueError, match='must not exist'):
        restore_backup(backup, destination, key)
    with pytest.raises(InvalidToken):
        restore_backup(backup, tmp_path / 'wrong-key', Fernet.generate_key().decode())
    assert not (tmp_path / 'wrong-key').exists()


@pytest.mark.parametrize('mode', ['traversal', 'checksum'])
def test_restore_rejects_unsafe_or_corrupt_archive(tmp_path, mode):
    key = Fernet.generate_key()
    content = io.BytesIO()
    name = '../escape' if mode == 'traversal' else 'database.dump'
    with zipfile.ZipFile(content, 'w') as archive:
        archive.writestr(name, b'bad')
        archive.writestr('manifest.json', json.dumps({'version': 1, 'database': 'sqlite', 'sha256': {name: 'invalid'}}))
    backup = tmp_path / 'bad.fernet'
    backup.write_bytes(Fernet(key).encrypt(content.getvalue()))
    with pytest.raises(ValueError):
        restore_backup(backup, tmp_path / 'destination', key.decode())
    assert not (tmp_path / 'destination').exists()
    assert not (tmp_path / 'escape').exists()


def test_public_launch_refuses_missing_operator_mail_and_default_model():
    from app.config import Settings, production_problems
    s = Settings(app_env='production', public_launch=True, jwt_secret='x' * 40, pia_agent_secret=Fernet.generate_key().decode(), cors_origins='https://pia.example.com')
    problems = ' '.join(production_problems(s))
    assert all(name in problems for name in ['PUBLIC_BASE_URL', 'OPERATOR_NAME', 'SMTP', 'REQUIRE_VERIFIED_EMAIL', 'DEFAULT_LLM_API_KEY', 'DELETION_JOURNAL_PATH'])
