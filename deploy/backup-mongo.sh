#!/usr/bin/env bash
# Daily MongoDB backup kept for 14 days (installed in cron by setup-vps.sh).
# Restore one with: mongorestore --gzip --archive=/srv/blank/backups/<file> --drop
set -euo pipefail
cd /srv/blank
set -a && . ./.env && set +a
mkdir -p backups
mongodump --uri="$MONGODB_URI" --gzip --archive="backups/blank-$(date +%F).archive.gz"
find backups -name 'blank-*.archive.gz' -mtime +14 -delete
