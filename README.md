# Pirento Blank — Trading Journal

Blank is an invite-only trading journal for the Indian market: journal P&L with configurable
brokerage and statutory charges, trade and strategy records, a risk calculator with saved order
plans, deterministic backtesting with reviewable research evidence, weekly/monthly reports,
OpenAI-assisted research and broker links. Zerodha, Dhan, Upstox, Fyers and Angel One fills come
into the journal (daily automatic import); balance, holdings and live orders are Zerodha only.

**Stack:** Node.js 22 · Express 4 (MVC) · MongoDB with Mongoose 8 · EJS templates · plain
JavaScript ES modules (no TypeScript, no client build step) · Tailwind CSS 4 · Chart.js ·
OpenAI Responses API · Zerodha Kite Connect.

## Quick start

Requires Node.js 22.13+ and pnpm 11.

```bash
pnpm install
cp .env.example .env
pnpm run build:css

# Option A — no MongoDB installed: in-memory database with seeded accounts
pnpm run dev:memory          # http://localhost:3000

# Option B — your own MongoDB (local or Atlas) in MONGODB_URI
ADMIN_EMAIL=you@gmail.com pnpm run seed:admin
pnpm run dev
```

Administrators have no password: they sign in at `/admin/login` with Google and then an
authenticator app. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_AUTH_ENABLED=true`
in `.env` first (Google redirect URI: `<APP_URL>/auth/google/callback`). The first
authenticator needs a setup code from email or `node scripts/admin-setup-code.js <email>`.
See [START-HERE.md](START-HERE.md) for the whole flow.

Run `pnpm run watch:css` alongside `pnpm run dev` while editing templates or client scripts.

## Commands

| Command                               | Purpose                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `pnpm run dev`                        | Start the server with file watching                                 |
| `pnpm start`                          | Start the production server                                         |
| `pnpm run dev:memory`                 | Start against a throwaway in-memory MongoDB                         |
| `pnpm run build` / `build:css`        | Compile `assets/css/app.css` → `public/css/app.css`                 |
| `pnpm run seed:admin`                 | Create or reset the first administrator                             |
| `pnpm run maintenance:voice-notes`    | Remove expired temporary voice-note uploads (cron)                  |
| `pnpm run maintenance:weekly-reports` | Send weekly report emails to members who opted in (cron)            |
| `pnpm run maintenance:price-checks`   | Paper trade stops/targets, price alerts, automatic GTTs (cron)      |
| `pnpm run maintenance:daily-import`   | Bring today's broker fills into members' journals (cron)            |
| `pnpm run maintenance:premarket-plan` | Send the pre-market plan on Telegram to members who opted in (cron) |
| `pnpm run lint`                       | ESLint                                                              |
| `pnpm run format:check`               | Prettier                                                            |
| `pnpm test`                           | Vitest: domain, client-module and server integration tests          |
| `pnpm run test:e2e`                   | Playwright browser tests against an in-memory server (`tests/e2e`)  |

## Project layout

```
server.js              process entry (connect DB, listen, graceful shutdown)
app.js                 Express app factory (security headers, static files, sessions, routes)
config/                environment, database connection, navigation
models/                Mongoose schemas (users, trades, strategies, plans, evidence, …)
controllers/           request handlers (pages, auth, MFA, workspace, Kite, admin, …; ai/ per feature)
services/              business logic, by area: auth/, journal/, market/ (Kite, Yahoo), broker/,
                       ai/, admin/, maintenance/, plus shared helpers (storage, mail, crypto)
middleware/            sessions, CSRF/CSP, authentication guards, view helpers, errors
routes/                web.js (EJS pages), admin.js (admin panel pages under /admin),
                       auth.js (/auth/*), api.js (/api/*)
views/                 EJS layouts, partials and one template per page
public/js/             browser ES modules: core helpers, page scripts (large pages split into
                       a folder of the same name), components, libraries
shared/                universal domain code used by both server and browser (P&L, CSV, backtest…)
assets/css/            Tailwind entry and the original design-system stylesheets
scripts/               admin bootstrap, in-memory dev server, maintenance
tests/                 shared/ (domain + client modules), server/ (HTTP integration with MongoDB),
                       e2e/ (Playwright browser tests)
```

New to the code? Read [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) first (reading order, where
code goes, one request end to end, common tasks), then [docs/CODE-MAP.md](docs/CODE-MAP.md) (where
everything lives). See also
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATABASE.md](docs/DATABASE.md) (collections,
indexes, retention, backups), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
[docs/MIGRATION.md](docs/MIGRATION.md).

## Security model (summary)

- Invite-only membership; passwords hashed with bcrypt; optional username sign-in.
- Server-side sessions stored in MongoDB (`connect-mongo`), HttpOnly cookies, CSRF tokens on every
  state-changing request and a per-login session identity that rejects requests queued by a
  previous sign-in.
- Optional TOTP authenticator (RFC 6238) with replay protection; secrets encrypted at rest.
- Content-Security-Policy with per-request nonces; no inline event handlers.
- All workspace queries are scoped to the signed-in user; trade economics are always recomputed on
  the server.
