#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VPS for Pirento Blank.
# Usage (as a sudo user, from the unpacked code folder):
#   sudo bash deploy/setup-vps.sh blank.example.com you@example.com
# Installs Node.js 22, pnpm, PM2, Nginx, Certbot and MongoDB 8, copies the code
# to /srv/blank, creates .env with fresh secrets, builds, starts the app and
# requests an HTTPS certificate. Safe to re-run: existing .env is kept.
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash deploy/setup-vps.sh <domain> <email>}"
EMAIL="${2:?Usage: sudo bash deploy/setup-vps.sh <domain> <email>}"
APP_DIR=/srv/blank
APP_USER="${SUDO_USER:-$(id -un)}"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> System packages"
apt-get update -y
apt-get install -y curl git nginx ufw gnupg ca-certificates rsync cron xz-utils rclone certbot python3-certbot-nginx
systemctl enable --now cron

echo "==> Node.js 22, pnpm and PM2"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable
npm install -g pm2

echo "==> MongoDB 8 (local, bound to 127.0.0.1)"
if ! command -v mongod >/dev/null; then
  . /etc/os-release
  curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc |
    gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
  echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/8.0 multiverse" \
    > /etc/apt/sources.list.d/mongodb-org-8.0.list
  apt-get update -y
  apt-get install -y mongodb-org
fi
systemctl enable --now mongod

echo "==> Firewall: SSH and web only (the app and MongoDB stay on localhost)"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> Code in ${APP_DIR}"
mkdir -p "$APP_DIR"
# node_modules is copied too when present (the ready-to-upload bundle ships it).
rsync -a --delete --exclude .env --exclude backups --exclude logs "$SOURCE_DIR"/ "$APP_DIR"/
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "==> Creating .env with fresh secrets"
  cp .env.production.example .env
  sudo -u "$APP_USER" node scripts/generate-secrets.js > /tmp/blank-secrets
  while IFS='=' read -r key value; do
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  done < /tmp/blank-secrets
  rm -f /tmp/blank-secrets
  sed -i "s|https://blank.example.com|https://${DOMAIN}|g" .env
  sed -i "s|mailto:you@example.com|mailto:${EMAIL}|" .env
  chown "$APP_USER":"$APP_USER" .env
  chmod 600 .env
fi

echo "==> Install and build"
# CI=true lets pnpm replace an existing node_modules without asking.
sudo -u "$APP_USER" env CI=true corepack pnpm install --frozen-lockfile --prod
sudo -u "$APP_USER" env CI=true corepack pnpm run build

echo "==> Start with PM2 (restarts on reboot)"
sudo -u "$APP_USER" pm2 startOrReload ecosystem.config.cjs
sudo -u "$APP_USER" pm2 save
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$(eval echo ~"$APP_USER")" >/dev/null

echo "==> Nginx for ${DOMAIN}"
sed "s/blank.example.com/${DOMAIN}/g" deploy/nginx.conf.example > /etc/nginx/sites-available/blank
ln -sf /etc/nginx/sites-available/blank /etc/nginx/sites-enabled/blank
rm -f /etc/nginx/sites-enabled/default
# Separate lines: under set -e a failing command inside && would not stop the script.
nginx -t
systemctl enable nginx
systemctl reload-or-restart nginx

echo "==> HTTPS certificate (the domain's A record must already point here)"
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect || \
  echo "!! Certbot failed. Check the DNS A record, then run: sudo certbot --nginx -d ${DOMAIN}"

echo "==> Scheduled jobs and daily database backup"
CRON_FILE=$(mktemp)
sudo -u "$APP_USER" crontab -l 2>/dev/null | grep -v '/srv/blank' > "$CRON_FILE" || true
grep -v '^#' deploy/crontab.example | grep -v '^$' | sed 's#/var/log/blank-cron.log#/srv/blank/logs/cron.log#' >> "$CRON_FILE"
echo "30 21 * * * bash /srv/blank/deploy/backup-mongo.sh >> /srv/blank/logs/backup.log 2>&1" >> "$CRON_FILE"
echo "*/5 * * * * bash /srv/blank/deploy/health-check.sh >> /srv/blank/logs/health.log 2>&1" >> "$CRON_FILE"
mkdir -p "$APP_DIR/logs" && chown "$APP_USER":"$APP_USER" "$APP_DIR/logs"
# Fed on stdin: the temp file is root-only, and crontab reads it as $APP_USER.
sudo -u "$APP_USER" crontab - < "$CRON_FILE"
rm -f "$CRON_FILE"

echo
echo "Done. Next steps:"
echo "  1. Create the first administrator:"
echo "     cd /srv/blank && ADMIN_EMAIL=${EMAIL} ADMIN_PASSWORD='a long password' node scripts/create-admin.js"
echo "  2. Fill in KITE_API_KEY and KITE_API_SECRET in /srv/blank/.env, then: pm2 reload pirento-blank"
echo "  3. Whitelist this server's IP in the Kite developer profile: $(curl -fsS https://api.ipify.org || echo '<server IP>')"
echo "  4. Open https://${DOMAIN}/api/health — it should say \"ok\"."
