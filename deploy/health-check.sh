#!/usr/bin/env bash
# Every 5 minutes (cron, installed by setup-vps.sh): sends a Telegram message when
# the app or its database is down, the disk is nearly full, or no backup has
# succeeded for 26 hours. One message per change (problem found / all clear), not
# one every 5 minutes. Needs TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID in .env.
set -uo pipefail
cd "${APP_DIR:-/srv/blank}"
set -a && . ./.env && set +a
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ] || exit 0
mkdir -p logs
STATE=logs/health-state

problems=""
# /api/health answers 503 when MongoDB is unreachable, so -f catches both.
curl -fsS -m 10 -o /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" 2>/dev/null ||
  problems+="- App or database is down. Check: pm2 status, pm2 logs pirento-blank, systemctl status mongod"$'\n'
free_mb=$(($(df -Pk / | awk 'NR==2 {print $4}') / 1024))
[ "$free_mb" -lt 1024 ] &&
  problems+="- Only ${free_mb} MB disk free (MongoDB stops writing below 500 MB). Check: df -h /"$'\n'
# A fresh install has no backup yet: count from when .env was created.
last_ok=$(stat -c %Y backups/.last-ok 2>/dev/null || stat -c %Y .env)
[ $(($(date +%s) - last_ok)) -gt $((26 * 3600)) ] &&
  problems+="- No successful backup for over 26 hours. Check: logs/backup.log"$'\n'

# Both sides through $(...), which drops trailing newlines the same way.
problems=$(printf '%s' "$problems")
previous=$(cat "$STATE" 2>/dev/null || true)
[ "$problems" = "$previous" ] && exit 0
if [ -n "$problems" ]; then
  text="⚠️ Pirento Blank (${APP_URL:-server}) needs attention:"$'\n'"$problems"
else
  text="✅ Pirento Blank (${APP_URL:-server}) is OK again."
fi
# The token goes through stdin, not the command line, so other users cannot see it in ps.
if curl -fsS -m 15 -o /dev/null -K - --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${text}" <<<"url = \"https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage\""; then
  printf '%s' "$problems" >"$STATE"
  echo "$(date -Is) sent: ${text%%$'\n'*}"
else
  echo "$(date -Is) Telegram send failed; will retry in 5 minutes"
fi
