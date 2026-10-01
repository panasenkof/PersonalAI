#!/usr/bin/env bash
# Run from repo root with a running Compose installation. BACKUP_ENCRYPTION_KEY must be exported.
set -euo pipefail
: "${BACKUP_ENCRYPTION_KEY:?Export the separate backup Fernet key}"
backup_dir=${1:?Provide a dedicated backup directory}
retention_days=${BACKUP_RETENTION_DAYS:-30}
if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then printf 'BACKUP_RETENTION_DAYS must be positive\n' >&2; exit 1; fi
mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
backup_temp=$(mktemp -d)
resume() { docker compose start app worker >/dev/null; rm -rf "$backup_temp"; }
trap resume EXIT
# Freeze ALL writers for a consistent database + files snapshot; reminders/mail stop with APIs.
docker compose stop app worker
docker compose exec -T postgres pg_dump -U pia -d pia --format=custom --no-owner > "$backup_temp/database.dump"
archive="pia-$(date -u +%Y%m%dT%H%M%SZ).fernet"
docker compose run --rm --no-deps --user 0:0 -e BACKUP_ENCRYPTION_KEY \
  -v "$backup_temp:/snapshot:ro" -v "$backup_dir:/backups" app \
  python -m app.operations.backup create --writers-stopped --database /snapshot/database.dump \
  --blobs /app/data/blobs --archive "/backups/$archive"
# Preserve CURRENT deletion journal separately, outside snapshots. Mirror this file off-host too.
docker compose run --rm --no-deps --user 0:0 -v "$backup_dir:/backups" app \
  python -c 'from pathlib import Path; import os; p=Path("/app/data/deletions/accounts.log"); t=Path("/backups/current-deletions.log.tmp"); t.write_bytes(p.read_bytes() if p.exists() else b""); t.chmod(0o600); os.replace(t, "/backups/current-deletions.log")'
# Prune only this script's dated encrypted archives; never keys or the current deletion journal.
find "$backup_dir" -maxdepth 1 -type f -name 'pia-????????T??????Z.fernet' -mmin "+$((retention_days * 1440))" -delete
printf 'Backup: %s/%s\n' "$backup_dir" "$archive"
