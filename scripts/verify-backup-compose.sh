#!/usr/bin/env bash
# CI-only restore drill for a disposable Compose installation. Never targets the live DB.
set -euo pipefail
: "${BACKUP_ENCRYPTION_KEY:?Set a test backup key}"
backup_dir=$(mktemp -d)
cleanup() {
  docker compose run --rm --no-deps --user 0:0 -v "$backup_dir:/backups" app python -c 'import shutil; shutil.rmtree("/backups/restored", ignore_errors=True)' >/dev/null 2>&1 || true
  rm -rf "$backup_dir"
}
trap cleanup EXIT
# Seed a recognisable database row. API tests separately exercise authenticated user flows.
docker compose exec -T postgres psql -U pia -d pia -v ON_ERROR_STOP=1 -c "INSERT INTO users (id,email,password_hash,role,is_active,token_version,email_verified,created_at) VALUES ('00000000-0000-0000-0000-000000000001','restore-drill@example.invalid','unused','user',true,0,false,CURRENT_TIMESTAMP)"
docker compose run --rm --no-deps app python -c 'from pathlib import Path; Path("/app/data/blobs/restore-drill.bin").write_bytes(b"restore drill")'
./deploy/backup.sh "$backup_dir"
archive=$(find "$backup_dir" -maxdepth 1 -name 'pia-*.fernet' -printf '%f\n')
test -n "$archive"
docker compose run --rm --no-deps --user 0:0 -e BACKUP_ENCRYPTION_KEY -v "$backup_dir:/backups" app \
  python -m app.operations.backup restore --archive "/backups/$archive" --destination /backups/restored
docker compose exec -T postgres createdb -U pia pia_restore_drill
docker compose run --rm --no-deps --user 0:0 -v "$backup_dir:/backups:ro" app \
  python -c 'import sys; from pathlib import Path; sys.stdout.buffer.write(Path("/backups/restored/database.dump").read_bytes())' | \
  docker compose exec -T postgres pg_restore -U pia --no-owner --dbname=pia_restore_drill
count=$(docker compose exec -T postgres psql -U pia -d pia_restore_drill -tAc "SELECT count(*) FROM users WHERE email='restore-drill@example.invalid'")
test "$count" = 1
docker compose run --rm --no-deps --user 0:0 -v "$backup_dir:/backups:ro" app \
  python -c 'from pathlib import Path; assert Path("/backups/restored/blobs/restore-drill.bin").read_bytes()==b"restore drill"'
curl --fail --retry 5 --retry-delay 2 http://localhost:8000/ready
echo 'PASS Postgres encrypted backup, isolated restore, files and service restart'
