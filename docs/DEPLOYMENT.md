# Deployment

Blank is one long-lived Node.js 22 process plus a MongoDB database. It needs HTTPS in production:
session cookies are `Secure`, so sign-in only works behind TLS (`TRUST_PROXY=true` when a proxy such
as Nginx terminates HTTPS).

Pick one path:

| Path                               | Good for                                |
| ---------------------------------- | --------------------------------------- |
| **A. Hostinger VPS + PM2 + Nginx** | Most control, lowest cost (Ubuntu VPS)  |
| **B. Docker Compose**              | Any server with Docker; bundles MongoDB |
| **C. Hostinger Node.js web app**   | Managed Node hosting with MongoDB Atlas |

## 1. Database

Use **MongoDB Atlas** (free tier works to start) or the MongoDB in Docker Compose (path B).

Atlas: create a cluster → _Database Access_: add a user → _Network Access_: allow your server's IP →
_Connect → Drivers_: copy the URI, for example
`mongodb+srv://blank:<password>@cluster0.example.mongodb.net/blank`. Indexes are created on start-up.

## 2. Environment

Copy `.env.example` to `.env` on the server and set at least:

| Variable         | Value                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`       | `production`                                                                                                            |
| `APP_URL`        | Your public HTTPS address, e.g. `https://blank.example.com`                                                             |
| `MONGODB_URI`    | Connection string                                                                                                       |
| `SESSION_SECRET` | 32+ random characters: `openssl rand -base64 48`. Changing it signs everyone out and invalidates authenticator secrets. |
| `TRUST_PROXY`    | `true` behind Nginx / a load balancer / Hostinger's proxy                                                               |
| `CRON_SECRET`    | 32+ random characters, for the scheduled jobs                                                                           |

Optional: `OPENAI_API_KEY` (AI features), `SMTP_*` (email invitations, password reset email, weekly
reports, alert emails), `VAPID_*` (push notifications), `GOOGLE_*` (Google sign-in for invited addresses), `KITE_*` and
`BROKER_TOKEN_ENCRYPTION_KEY` (Zerodha), `LIVE_TRADING_*` (see section 6).

### Without email (SMTP)

Blank works without SMTP. Administrators invite members with **private links** and, when a member
forgets their password, create a one-hour **reset link** from _Administration → Members → Reset
link_. Both links are shown once and must be shared with the member directly. Weekly report emails
need SMTP.

## Quick path: one script on a fresh Ubuntu VPS

`deploy/setup-vps.sh` does path A below in one go: Node.js 22, pnpm, PM2, Nginx, Certbot, a local
MongoDB 8 (bound to localhost), a firewall, the code in `/srv/blank`, a `.env` from
`.env.production.example` with fresh secrets (`scripts/generate-secrets.js`), the build, PM2, the
HTTPS certificate, the scheduled jobs and a daily MongoDB backup (`deploy/backup-mongo.sh`, 14 days
kept in `/srv/blank/backups`). Set `BACKUP_REMOTE` in `.env` to an rclone remote (an encrypted
`crypt` remote over Google Drive or S3 is recommended) and each backup is also copied off the server,
with 30 days kept there; `START-HERE.md` has the `rclone config` steps. `deploy/health-check.sh`
runs every 5 minutes and, with `TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` set (send `/chatid`
to the bot), sends one Telegram message when the app or database is down, under 1 GB of disk is free
or no backup has succeeded for 26 hours, and another when all is clear.

```bash
# Point the domain's A record at the VPS first, then from the unpacked code folder:
sudo bash deploy/setup-vps.sh blank.example.com you@example.com
```

It prints the remaining steps: create the administrator, add the Kite keys, whitelist the server IP.
`MFA_ENCRYPTION_KEY` is separate from `SESSION_SECRET` on new installs, so rotating the session
secret keeps authenticators working. Do not add it to an existing install whose members already use
authenticators: their codes were encrypted with a key derived from `SESSION_SECRET`.

## A. Hostinger VPS (Ubuntu) with PM2 and Nginx

```bash
# 1. System packages (as root or with sudo)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2
sudo corepack enable

# 2. Code
sudo mkdir -p /srv/blank && sudo chown $USER /srv/blank
git clone https://github.com/pirento/Blank-2.0.git /srv/blank
cd /srv/blank
cp .env.example .env && nano .env        # fill in section 2
pnpm install --frozen-lockfile --prod
pnpm run build

# 3. First administrator (once)
ADMIN_EMAIL=you@gmail.com node scripts/create-admin.js

# 4. Run and keep running after reboots
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup                  # run the command it prints

# 5. HTTPS reverse proxy
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/blank
sudo nano /etc/nginx/sites-available/blank   # set your domain
sudo ln -s /etc/nginx/sites-available/blank /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d blank.example.com
```

Point your domain's **A record** to the VPS IP before running certbot. If the repository is private,
clone it with a GitHub personal access token or a deploy key.

**Updating:** back up first (`bash deploy/backup-mongo.sh`; re-running `deploy/setup-vps.sh` does
this for you), then `cd /srv/blank && git pull && pnpm install --frozen-lockfile --prod && pnpm run build && pm2 reload pirento-blank`.
New versions can add retention (TTL) indexes that delete old rows on first start (see
docs/DATABASE.md), and the backup is the only way back.

## B. Docker Compose

```bash
git clone https://github.com/pirento/Blank-2.0.git && cd Blank-2.0
cp .env.example .env && nano .env        # APP_URL, SESSION_SECRET, CRON_SECRET, …
docker compose up -d --build
docker compose exec -e ADMIN_EMAIL=you@example.com app node scripts/create-admin.js
```

The app listens on `127.0.0.1:3000`; put Nginx with HTTPS in front of it (step A5). MongoDB data is
kept in the `mongo-data` volume; Compose points the app at its own MongoDB, so `MONGODB_URI` in `.env`
is overridden. Back it up with `docker compose exec mongo mongodump --archive > blank.archive`.

## C. Hostinger Node.js web app (managed)

1. hPanel → **Websites → Add website → Node.js app** (Node 22). Connect the GitHub repository or
   upload the files.
2. Build command: `npm install && npm run build` · Entry file: `server.js`.
3. Add the environment variables from section 2 in the panel (MongoDB Atlas for `MONGODB_URI`, and
   `TRUST_PROXY=true`).
4. Deploy, attach your domain and enable SSL.
5. Create the first administrator from the panel's terminal:
   `ADMIN_EMAIL=you@gmail.com node scripts/create-admin.js`.

Panel names change from time to time; the build command, entry file and variables above are what
matter.

## 4. Scheduled jobs

Copy `deploy/crontab.example` into `crontab -e` and adjust the path:

- **Daily** — `node scripts/maintenance-voice-notes.js` removes temporary voice-note uploads older
  than 24 hours.
- **Daily** — `node scripts/maintenance-signups.js` deletes public sign-ups whose email was never
  confirmed within 7 days (connects to MongoDB directly; admin invitations are never touched).
- **Monday morning** — `node scripts/send-weekly-reports.js` emails last week's report to members who
  opted in (Settings → Email reports). Each member gets one email per week; re-running is safe.

- **Every 5 minutes in market hours** — `node scripts/price-checks.js` closes paper trades whose stop
  or target was crossed and fires price alerts.

All of them call the running server with `Authorization: Bearer $CRON_SECRET`.

### Telegram bot (optional)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token and username.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET` (32+ random
   characters, e.g. `openssl rand -hex 32`) in `.env`, restart, then run
   `node scripts/telegram-set-webhook.js` once (needs the HTTPS `APP_URL`).
3. Members link their chat in Settings → Telegram, then use `/log`, `/today`, `/week`, `/alerts` and
   receive price alerts there.

### Push notifications and the installable app

Blank is a PWA: members can install it from the browser ("Install app" in Settings → Notifications &
app, or "Add to Home Screen"). Price alerts are delivered as push notifications once the server has a
VAPID key pair:

```bash
node scripts/generate-vapid-keys.js   # prints VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY for .env
```

Also set `VAPID_SUBJECT` (`mailto:you@example.com` or your site URL). Push needs HTTPS. Each member
turns notifications on per device in Settings. Without VAPID keys, alerts still work by email (with
SMTP) and in the page while the Watchlist is open.

## 5. Zerodha Kite

Register `https://<your-domain>/api/kite/callback` as the redirect URL in the Kite developer console
and set `KITE_REDIRECT_URI` to the same value. Broker linking requires HTTPS. Administrators can
reload the NSE instrument list from Settings → Trading connection.

Creating the app at developers.kite.trade → My apps → Create new app:

| Field                  | Value                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type                   | **Personal** (free) is enough for login, portfolio, fills, live orders and GTT; quotes and charts then come from Yahoo. **Connect** (paid) adds Zerodha live quotes and historical candles. |
| App name / Description | Anything, e.g. "Pirento Blank journal".                                                                                                                                                     |
| Zerodha Client ID      | Your own client ID; only that account can log in to a Personal app.                                                                                                                         |
| Redirect URL           | `https://<your-domain>/api/kite/callback` (must match `KITE_REDIRECT_URI`).                                                                                                                 |
| Postback URL           | Leave empty; the app reads order status itself.                                                                                                                                             |

Copy the API key and secret into `KITE_API_KEY` and `KITE_API_SECRET` on the server only.
Since 1 April 2026 Zerodha accepts API order placement, modification and cancellation only from a
static IP registered on the Kite developer profile, so run the app on a VPS with a fixed IP and add
that IP there. Reading data (login, portfolio, fills) works from any IP. When an app lacks a
permission (for example quotes on a Personal app), Zerodha's refusal no longer disconnects the
session; the app falls back to Yahoo for six hours.

### Dhan (optional)

No server setup is needed. Each member creates a personal access token at web.dhan.co → My
Profile → DhanHQ Trading APIs and pastes it in Settings → Dhan. It is checked against Dhan's
profile endpoint, stored encrypted with `BROKER_TOKEN_ENCRYPTION_KEY` and used read-only to bring
today's fills into the journal. Dhan tokens expire (usually after a day); members paste a new one
when Settings says it has expired.

## 6. Live orders (real money)

Live orders are **off** by default. To allow them:

1. Configure Zerodha (section 5) and set `LIVE_TRADING_ENABLED=true`.
2. Review the limits: `LIVE_ORDER_MAX_VALUE` (₹ per order, default 50,000),
   `LIVE_ORDER_MAX_QUANTITY` (default 1,000), `LIVE_ORDER_DAILY_LIMIT` (per member per day,
   default 5), `LIVE_ORDER_MAX_PRICE_DEVIATION_PERCENT` (default 3).
3. Each member must verify an authenticator and turn on _Settings → Live orders_.

An order is then sent only for a **reviewed, synced plan**, only while the market is open, only once
per plan, and only after the member types the symbol to confirm. It is a regular **DAY LIMIT** order
at the plan's entry price on NSE; the planned stop and target are **not** placed automatically.
Every attempt is recorded (placed, rejected or unknown) and shown on the Order review page. Test with
a small quantity first.

For a **delivery (CNC) buy**, once Zerodha reports it completely filled, the Order review page offers
**Place stop & target (GTT)**: one GTT that sells the filled quantity at the plan's stop-loss (as a
LIMIT 0.5% below the trigger) or at its target, whichever comes first. Both triggers must be at least
0.25% from the current price, and the symbol must be typed to confirm. Zerodha GTTs do not support
intraday (MIS) positions, so MIS orders need their stop placed in Kite.

## 7. Health check and logs

`GET /api/health` returns `{"status":"ok", …}` with integration flags. The Docker image uses it as its
`HEALTHCHECK`; point an uptime monitor (for example UptimeRobot) at the same URL.

In production every log line is one JSON object (`time`, `level`, `scope`, `msg`, …), one per
request plus warnings and errors. Read them with `pm2 logs pirento-blank` or
`docker compose logs -f app`. Every response carries an `X-Request-Id` header; the same ID appears
in the request's log line, so a reported problem can be traced. Set `LOG_LEVEL=warn` for quieter
logs or `LOG_FORMAT=text` for plain lines. Logs never contain passwords, tokens, request bodies or
AI prompts.
