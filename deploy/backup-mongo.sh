#!/usr/bin/env bash
# Daily MongoDB backup kept for 14 days (installed in cron by setup-vps.sh).
# With BACKUP_REMOTE set in .env (an rclone remote such as "gdrive-secret:"), each
# backup is also copied off the server and remote copies are kept for 30 days.
# Restore one with: mongorestore --gzip --archive=/srv/blank/backups/<file> --drop
set -euo pipefail
cd "${APP_DIR:-/srv/blank}"
set -a && . ./.env && set +a
mkdir -p backups
FILE="backups/blank-$(date +%F).archive.gz"
mongodump --uri="$MONGODB_URI" --gzip --archive="$FILE"
find backups -name 'blank-*.archive.gz' -mtime +14 -delete

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$FILE" "$BACKUP_REMOTE"
  rclone delete --min-age 30d --include 'blank-*.archive.gz' "$BACKUP_REMOTE"
  echo "$(date -Is) uploaded $FILE to $BACKUP_REMOTE"
fi
