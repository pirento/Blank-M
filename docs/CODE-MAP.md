# Code map

Where things live and where to start when you need to change something. The file tables at the
end are generated from each file's header comment, so keep those comments up to date.

## How a request flows

```
Page:  browser ─► routes/web.js ─► middleware (session, CSRF, auth) ─► controllers/pages.controller.js
                                                                      └─► views/pages/<page>.ejs
                                                                          + public/js/pages/<page>.js

API:   browser fetch ─► routes/api.js ─► middleware ─► controllers/… ─► services/… ─► models/…
```

1. `routes/` maps a URL to one controller function (every handler is wrapped so async errors reach
   `middleware/errors.js`).
2. `controllers/` read and validate the request (Zod), call services and shape the response.
3. `services/` hold the business rules and talk to MongoDB (`models/`) and outside services
   (Zerodha, Yahoo, OpenAI, SMTP).
4. `shared/` is domain code used by **both** the server and the browser (P&L, charges, risk
   calculator, CSV import, backtest, order plans), so the browser preview and the saved value
   always match.

## Two controller styles

- **Express style** (`workspace`, `account`, `auth`, `mfa`, `order-plans`, `strategy-evidence`,
  `uploads`, `username`): routes add `requireApiAuth`, handlers throw `HttpError` and the
  error middleware writes the response.
- **Self-contained handlers** (`ai/`, `admin`, `admin-ai`, `manual-invitations`, `research`,
  `voice-note-cleanup`, `kite`, `market`): each checks the method, authenticates
  and writes its own error responses, because their messages and status codes are part of the
  contract the browser relies on (for example "No successful access change is confirmed").

Both are registered the same way in `routes/api.js`. New endpoints should use the Express style.

## Browser pages

Each page has an EJS view (`views/pages/<page>.ejs`) and one browser module
(`public/js/pages/<page>.js`). The server embeds the page's data as JSON (`#page-data`), read with
`pageData()`.

Large pages are split into a folder with the same name. The `<page>.js` file stays the entry: it
imports the parts and runs the start-up code (event listeners, first paint, first loads) in a fixed
order. The folder holds:

- `shared.js` — page data, state and small helpers used by several parts.
- one file per section (for example `dashboard/market.js`, `dashboard/record.js`).

Split pages: `analytics`, `calculator`, `dashboard`, `import`, `reports`, `settings`, `today`,
`users`. Module-level values that are reassigned after start-up are kept in a shared object (for
example `storeRef.current`) so every part sees the same value.

Common browser helpers live in `public/js/core/` (`dom.js` element builder, cards, buttons, fields,
`formatIstDateTime`, `statusLine`/`errorLine`; `api.js` fetch with CSRF; `dialog.js`; `toast.js`).

## Where to change…

| I want to change…                                    | Start here                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| How P&L or charges are calculated                    | `shared/pnl.js` (tests: `tests/shared/pnl.test.js`)                                               |
| Position size / stop / target maths                  | `shared/risk-calculator.js`                                                                       |
| Options payoff and Greeks                            | `shared/options.js`, `public/js/pages/options.js`                                                 |
| Insights edge map (weekday × time, best/worst)       | `shared/edge-map.js`, `public/js/pages/insights.js`                                               |
| CSV / Excel import parsing                           | `shared/csv.js`, `shared/spreadsheet-data.js`, `public/js/pages/import/`                          |
| Broker tradebooks (Zerodha, Upstox, Angel One, Dhan) | `shared/tradebook.js` → `shared/broker-fills.js`, used by `public/js/pages/import/reading.js`     |
| Sign-in, sessions, password reset                    | `services/auth/accounts.js`, `controllers/auth.controller.js`                                     |
| Authenticator (MFA)                                  | `services/auth/totp.js`, `controllers/mfa.controller.js`                                          |
| Invitations and member access                        | `controllers/admin.controller.js`, `services/admin/`                                              |
| Trades, strategies, rules, watchlist storage         | `services/journal/workspace.js`, `controllers/workspace.controller.js`                            |
| Backup / restore                                     | `services/journal/backup.js`                                                                      |
| Weekly report email                                  | `services/journal/weekly-report.js`, `scripts/send-weekly-reports.js`                             |
| Quotes and price history                             | `services/market/` (Kite first, Yahoo fallback)                                                   |
| Zerodha login, balance, portfolio                    | `services/market/kite/`, `services/broker/`, `controllers/kite.controller.js`                     |
| Dhan fills → journal                                 | `services/broker/dhan.js`, `services/broker/fills-journal.js`, `public/js/pages/settings/dhan.js` |
| Live orders                                          | `services/broker/live-orders.js`, `public/js/pages/orders.js`                                     |
| AI prompts and endpoints                             | `controllers/ai/`, `services/ai/openai.js`                                                        |
| AI models and limits                                 | `services/ai/config.js`, `services/ai/usage-limits.js`                                            |
| Saved research history                               | `services/ai/research-archive.js`, `controllers/research.controller.js`                           |
| Security headers, CSRF, CSP                          | `middleware/security.js`                                                                          |
| Navigation menu                                      | `config/nav.js`                                                                                   |
| Page layout, top bar, dock                           | `views/layouts/workspace.ejs`, `views/partials/`                                                  |
| Styles                                               | `assets/css/` (Tailwind; `pnpm run build`)                                                        |

## Tests

- `tests/shared/` — domain code and browser modules (Vitest + jsdom).
- `tests/server/` — HTTP integration tests against an in-memory MongoDB (`tests/helpers/app.js`).
- `tests/e2e/` — Playwright tests that drive the real app in Chromium (`pnpm run test:e2e`). Each
  spec signs in as its own seeded member (see `tests/e2e/helpers.js`).

## Files

### Root

| File        | What it does                   |
| ----------- | ------------------------------ |
| `app.js`    | Builds the Express application |
| `server.js` | Node entry point               |

### `config/`

| File          | What it does                                                          |
| ------------- | --------------------------------------------------------------------- |
| `database.js` | MongoDB connection (Mongoose)                                         |
| `env.js`      | Loads .env and checks the runtime configuration needed in production. |
| `nav.js`      | Reference section order, mapped to the functional application routes. |

### `controllers/`

| File                               | What it does                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `account.controller.js`            | Account endpoints                                                                     |
| `admin-ai.controller.js`           | Administrator AI settings                                                             |
| `admin.controller.js`              | Administrator member management                                                       |
| `ai.controller.js`                 | Blank AI HTTP handlers.                                                               |
| `auth.controller.js`               | Sign-in endpoints                                                                     |
| `kite.controller.js`               | Zerodha Kite endpoints                                                                |
| `dhan.controller.js`               | Dhan token connection and today's fills → journal                                     |
| `manual-invitations.controller.js` | HTTP handlers for private invitation links.                                           |
| `market.controller.js`             | Market endpoints                                                                      |
| `mfa.controller.js`                | Authenticator (TOTP) management                                                       |
| `order-plans.controller.js`        | Cloud history for order plans                                                         |
| `pages.controller.js`              | Server-rendered pages                                                                 |
| `research.controller.js`           | GET /api/research/runs                                                                |
| `strategy-evidence.controller.js`  | Backtest evidence for strategies                                                      |
| `uploads.controller.js`            | File uploads                                                                          |
| `username.controller.js`           | The member's optional sign-in username                                                |
| `voice-note-cleanup.controller.js` | Scheduled job endpoint that deletes temporary voice-note uploads older than 24 hours. |
| `workspace.controller.js`          | Journal data endpoints                                                                |

### `controllers/ai/`

| File                | What it does                      |
| ------------------- | --------------------------------- |
| `chat.js`           | POST /api/ai/chat                 |
| `coach.js`          | Coaching endpoints                |
| `drafting.js`       | Small structured AI helpers       |
| `journal-search.js` | POST /api/ai/journal-search       |
| `research.js`       | POST /api/ai/picks                |
| `shared.js`         | Helpers shared by the AI handlers |
| `voice.js`          | POST /api/ai/transcribe           |

### `middleware/`

| File              | What it does                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.js`         | Authentication middleware                                                                                                                                                                        |
| `errors.js`       | Final error handling for JSON API and pages, without leaking internal details.                                                                                                                   |
| `request-log.js`  | One log line per request (method, path, status, duration) with a request ID that is also returned in the X-Request-Id header, so a member can quote it and the matching server log can be found. |
| `security.js`     | Security middleware                                                                                                                                                                              |
| `session.js`      | Express sessions stored in MongoDB (connect-mongo) and the session cookie settings.                                                                                                              |
| `view-helpers.js` | Helpers available in every EJS view                                                                                                                                                              |

### `models/`

| File                  | What it does                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `AccountSettings.js`  | Per-user account settings.                                                                         |
| `Ai.js`               | AI models                                                                                          |
| `AllowedUser.js`      | The invite-only allowlist.                                                                         |
| `AuthToken.js`        | Single-use emailed links                                                                           |
| `BrokerConnection.js` | Encrypted broker access token, bound to one broker identity per account.                           |
| `ChatMessage.js`      | A message in the member's AI chat history.                                                         |
| `Counter.js`          | Atomic, monotonic counters (for example the order-plan server revision).                           |
| `Instrument.js`       | Zerodha instrument master (NSE equities), refreshed from the public CSV.                           |
| `LiveOrder.js`        | Audit log of live broker orders placed from saved plans.                                           |
| `LoginUsername.js`    | An optional immutable sign-in alias.                                                               |
| `ManualInvitation.js` | Private, single-use invitation links that send no email.                                           |
| `OrderPlanRecord.js`  | Append-only cloud copies of browser planning records.                                              |
| `RateWindow.js`       | Durable fixed-window counters shared by every server process (login and invitation quotas).        |
| `ResearchRun.js`      | Durable, owner-scoped research archive.                                                            |
| `Strategy.js`         | A written trading strategy (name, rules, improvements and notes) dated to the day it was recorded. |
| `StrategyEvidence.js` | Immutable client-computed research evidence, recomputed by the server before saving.               |
| `Trade.js`            | A completed round-trip trade in the journal, with its stored gross P&L and charges.                |
| `TradingRule.js`      | A trading rule in the member's rule book, grouped by section and ordered.                          |
| `User.js`             | A member account                                                                                   |
| `WatchlistItem.js`    | An instrument on the member's watchlist.                                                           |
| `helpers.js`          | Schema building blocks shared by the models                                                        |
| `index.js`            | All Mongoose models, imported once so they are registered with the connection.                     |

### `public/js/components/`

| File                         | What it does                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ai-gate.js`                 | Notices shown instead of AI controls when the server has no OpenAI key.                                                  |
| `broker-portfolio.js`        | Zerodha portfolio panel                                                                                                  |
| `charts.js`                  | Chart.js area and bar charts in the app's colours (repainted on theme change).                                           |
| `markdown.js`                | Safe markdown rendering for AI output (marked + DOMPurify) with app styling.                                             |
| `market-history-chart.js`    | Price history chart for one instrument                                                                                   |
| `strategy-evidence-panel.js` | Strategy evidence panel                                                                                                  |
| `trade-form.js`              | One trade form, used both to log a new trade in the Journal and to correct an existing one from the Transactions ledger. |
| `trade-replay.js`            | Trade replay: the trade day's candles with its entry, exit and stop-loss marked.                                         |

### `public/js/core/`

| File                 | What it does                                                                        |
| -------------------- | ----------------------------------------------------------------------------------- |
| `api.js`             | Same-origin JSON client.                                                            |
| `dialog.js`          | Accessible dialogs, sheets and modals with focus trapping (one shared stack).       |
| `dom.js`             | Small DOM helpers used by every page module (no UI framework).                      |
| `shell.js`           | Workspace shell behaviour shared by every member page                               |
| `command-palette.js` | Command palette (⌘K) and keyboard shortcuts                                         |
| `stack-tables.js`    | Phone card layout for wide tables                                                   |
| `format.js`          | Signed rupee amounts and P&L colour classes                                         |
| `theme.js`           | Browser-local theme preference.                                                     |
| `toast.js`           | Toast notifications (instead of window.alert), including ones shown after a reload. |

### `public/js/lib/`

| File                   | What it does                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ai.js`                | Browser client for the AI endpoints                                                                                          |
| `import-ledger.js`     | Browser checkpoint for a trade import, so an interrupted import can be resumed or retried without creating duplicate trades. |
| `live-quotes.js`       | Live Zerodha prices over Server-Sent Events (/api/quotes/stream), when the Kite app has market data.                         |
| `market-chart.js`      | Loads and validates price history for the market chart.                                                                      |
| `order-plan-sync.js`   | Syncs browser order plans with their private cloud copy (append-only, per member) and reports sync status.                   |
| `order-plans-store.js` | Order plans for one member in this browser, kept in sync with the cloud copy.                                                |
| `pdf.js`               | Renders a report element into a paginated A4 PDF.                                                                            |
| `quotes.js`            | Browser client for quotes, price history and the Zerodha connection endpoints.                                               |
| `research-store.js`    | Browser archive of AI research runs for one member, merged with the cloud history.                                           |
| `strategy-evidence.js` | Same-origin client for the append-only research evidence archive.                                                            |
| `views.js`             | Saved filter views for the transactions ledger.                                                                              |

### `public/js/pages/`

| File                                | What it does                                                          |
| ----------------------------------- | --------------------------------------------------------------------- |
| `accept-invitation.js`              | Accept a private invitation link                                      |
| `analytics.js`                      | Analytics page                                                        |
| `auth-link.js`                      | Emailed activation and password-recovery links                        |
| `backtest.js`                       | Runs a real simulation over real candles.                             |
| `calculator.js`                     | Position calculator                                                   |
| `dashboard.js`                      | Overview page                                                         |
| `import.js`                         | Bulk import from a broker CSV or Excel workbook.                      |
| `journal.js`                        | Journal page                                                          |
| `login.js`                          | Login page                                                            |
| `mfa-challenge.js`                  | Authenticator challenge after sign-in (verifies a 6-digit TOTP code). |
| `options.js`                        | Options payoff page: F&O legs, payoff at expiry and today, Greeks.    |
| `orders.js`                         | Order review page                                                     |
| `orders/live-dialogs.js`            | Live order and stop/target GTT dialogs                                |
| `reports.js`                        | Reports page                                                          |
| `rules.js`                          | Rules page                                                            |
| `settings.js`                       | Settings page entry                                                   |
| `strategy.js`                       | Strategy manager.                                                     |
| `today.js`                          | Today page                                                            |
| `transactions.js`                   | The trade ledger.                                                     |
| `../components/trade-screenshot.js` | Trade chart screenshot dialog                                         |
| `users.js`                          | Administration page                                                   |
| `watchlist.js`                      | Watchlist page                                                        |

### `public/js/pages/analytics/`

| File        | What it does                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `chat.js`   | Sends a question (with optional file or voice-note preparation) and streams the answer.                                    |
| `input.js`  | Question box helpers                                                                                                       |
| `render.js` | Renders the conversation, the streaming answer and the side panels.                                                        |
| `shared.js` | Analytics page data and state, the in-flight request trackers and helpers that keep conversation actions from overlapping. |
| `tools.js`  | Structured tools that post into the conversation                                                                           |

### `public/js/pages/calculator/`

| File             | What it does                                                                     |
| ---------------- | -------------------------------------------------------------------------------- |
| `broker-sync.js` | Syncs the trading capital from the linked Zerodha balance.                       |
| `fields.js`      | Form fields                                                                      |
| `layout.js`      | Static calculator layout                                                         |
| `painting.js`    | Repaints mode, quote, sync status and the estimate (with save / sync controls).  |
| `quotes.js`      | Latest quote for the selected symbol (fills the entry price) and symbol changes. |
| `shared.js`      | Calculator page data, form state and the input/error element registries.         |

### `public/js/pages/dashboard/`

| File           | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| `checklist.js` | Getting-started checklist (can be dismissed; remembered in localStorage). |
| `market.js`    | Market workspace                                                          |
| `plans.js`     | Recent order plans from the local/cloud plan store.                       |
| `record.js`    | Trading record                                                            |
| `shared.js`    | Dashboard page data from the server and shared constants.                 |

### `public/js/pages/import/`

| File         | What it does                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cards.js`   | The saved-batch card and the choose-a-file card.                                                                                         |
| `mapping.js` | Column mapping, sheet picker, summary tiles and the row preview.                                                                         |
| `paint.js`   | Renders the current import stage.                                                                                                        |
| `reading.js` | Reading the chosen file                                                                                                                  |
| `run.js`     | Running the import row by row with a browser checkpoint, and closing a saved batch.                                                      |
| `shared.js`  | Import page data and state, including recovery of a saved import checkpoint, and the derived preview (candidates, duplicates, problems). |

### `public/js/pages/reports/`

| File                   | What it does                                      |
| ---------------------- | ------------------------------------------------- |
| `journal-generator.js` | Journal report generator                          |
| `journal-report.js`    | Journal performance report                        |
| `planning.js`          | Planning report                                   |
| `shared.js`            | Reports page data from the server.                |
| `source.js`            | Switches between the planning and journal report. |

### `public/js/pages/settings/`

| File               | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| `ai.js`            | Settings page — Blank AI.                                                  |
| `backup.js`        | Settings page — data backup.                                               |
| `broker.js`        | Settings page — broker connection.                                         |
| `capital.js`       | Settings page — capital preferences.                                       |
| `charges.js`       | Settings page — charges.                                                   |
| `daily-journal.js` | Settings page — daily automatic journal and pre-market plan on Telegram.   |
| `email-reports.js` | Settings page — email reports.                                             |
| `live-trading.js`  | Settings page — live orders.                                               |
| `mfa.js`           | Settings page — MFA settings.                                              |
| `sessions.js`      | Settings page — signed-in devices.                                         |
| `shared.js`        | Shared state and small helpers used by more than one section of this page. |
| `username.js`      | Settings page — username settings.                                         |

### `public/js/pages/today/`

| File           | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `actions.js`   | User actions                                             |
| `archive.js`   | Saved research runs                                      |
| `cards.js`     | Capital card, briefing section and the page paint.       |
| `history.js`   | Research history list (this browser and cloud).          |
| `shared.js`    | Today page data, state and small formatting helpers.     |
| `shortlist.js` | Analysis status and today's shortlist of research picks. |

### `public/js/pages/users/`

| File               | What it does                                                  |
| ------------------ | ------------------------------------------------------------- |
| `email-members.js` | Members invited by email                                      |
| `paint.js`         | Renders the whole administration page from the current state. |
| `private-links.js` | Private invitation links                                      |
| `shared.js`        | Users page state and small formatting helpers.                |

### `routes/`

| File      | What it does                                                             |
| --------- | ------------------------------------------------------------------------ |
| `api.js`  | JSON API routes under /api.                                              |
| `auth.js` | Authentication routes under /auth (sign-in, recovery, Google, sign-out). |
| `web.js`  | Server-rendered page routes.                                             |

### `scripts/`

| File                         | What it does                                         |
| ---------------------------- | ---------------------------------------------------- |
| `create-admin.js`            | Bootstrap the first administrator.                   |
| `dev-memory.js`              | Local preview without installing MongoDB             |
| `daily-import.js`            | Scheduled daily automatic journal (after the close). |
| `premarket-plan.js`          | Scheduled pre-market plan on Telegram (08:45 IST).   |
| `maintenance-voice-notes.js` | Scheduled voice-note cleanup (run daily from cron).  |
| `send-weekly-reports.js`     | Scheduled weekly report emails.                      |

### `services/`

| File              | What it does                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `crypto.js`       | Encryption helpers                                                               |
| `errors.js`       | Errors carrying an HTTP status; messages are safe to show the user.              |
| `http.js`         | Rejects anything but the expected method, so handlers can assume it.             |
| `icons.js`        | Lucide icons for EJS templates and the sprite used by browser modules.           |
| `logger.js`       | Structured logging.                                                              |
| `mailer.js`       | Outgoing email over SMTP (replaceable in tests).                                 |
| `rate-window.js`  | Durable fixed-window rate limits shared by all server processes.                 |
| `storage-path.js` | Storage download interpolates object paths into a URL under service credentials. |
| `storage.js`      | File storage in MongoDB GridFS                                                   |

### `services/admin/`

| File                    | What it does                                      |
| ----------------------- | ------------------------------------------------- |
| `contracts.js`          | Error for administrator and invitation operations |
| `manual-invitations.js` | Private invitation links (no email needed)        |

### `services/ai/`

| File                        | What it does                                          |
| --------------------------- | ----------------------------------------------------- |
| `config.js`                 | AI model configuration                                |
| `journal-index.js`          | Private journal search index                          |
| `openai-key.js`             | Reads the OpenAI API key from the server environment. |
| `openai.js`                 | OpenAI access for Blank AI                            |
| `premarket-plan.js`         | Pre-market plan on Telegram before the open           |
| `research-archive-store.js` | Saved research runs in MongoDB.                       |
| `research-archive.js`       | Saved research runs                                   |
| `research-universe.js`      | The NIFTY 500 research universe                       |
| `usage-limits.js`           | Per-member AI rate limits                             |

### `services/auth/`

| File              | What it does                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `accounts.js`     | Accounts and sign-in                                                        |
| `app-sessions.js` | Checks that a stored login session is still valid for broker requests.      |
| `request-auth.js` | Authenticated member lookup for API handlers (and the administrator check). |
| `totp.js`         | Time-based one-time passwords (RFC 6238) for authenticator apps.            |

### `services/broker/`

| File              | What it does                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `flow.js`         | Zerodha login flow security                                                                                            |
| `daily-import.js` | After the close: today's Zerodha/Dhan fills into the journal for opted-in members, with a Telegram summary.            |
| `live-orders.js`  | Live orders through Zerodha                                                                                            |
| `portfolio.js`    | Reads the member's Zerodha holdings, positions, orders and trades into the shape shared/broker-portfolio.js validates. |

### `services/journal/`

| File                  | What it does                                   |
| --------------------- | ---------------------------------------------- |
| `backup.js`           | Data backup                                    |
| `weekly-report.js`    | Weekly report emails                           |
| `workspace.js`        | Journal data access                            |
| `account-settings.js` | Planning capital, charge rates and risk limits |

### `services/maintenance/`

| File           | What it does                                                                 |
| -------------- | ---------------------------------------------------------------------------- |
| `authorize.js` | Authorises scheduled maintenance requests with the CRON_SECRET bearer token. |

### `services/market/`

| File             | What it does                             |
| ---------------- | ---------------------------------------- |
| `cache.js`       | Small in-process TTL cache.              |
| `index.js`       | Market data entry point                  |
| `instruments.js` | Zerodha instrument master (NSE equities) |
| `kite.js`        | Zerodha Kite Connect client.             |
| `types.js`       | Provider-agnostic market data contract.  |
| `yahoo.js`       | Yahoo Finance chart endpoint.            |

### `services/market/kite/`

| File             | What it does                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `account.js`     | Read-only account data (profile, holdings, positions, orders, trades and equity margins), always re-verifying the linked broker identity. |
| `client.js`      | Authenticated GET helper for the Kite REST API                                                                                            |
| `config.js`      | Zerodha Kite Connect configuration                                                                                                        |
| `connection.js`  | Stored Kite sessions                                                                                                                      |
| `market-data.js` | Kite market data provider                                                                                                                 |
| `orders.js`      | Order placement                                                                                                                           |
| `session.js`     | Kite login lifecycle                                                                                                                      |
| `ticker.js`      | Live prices from Kite's WebSocket, one connection per member shared by their open pages.                                                  |

### `shared/`

| File                    | What it does                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `ai-schemas.js`         | Zod schemas for AI requests and responses, shared by the server and browser.             |
| `broker-portfolio.js`   | Zod schemas and size limits for the read-only broker portfolio response.                 |
| `business-dates.js`     | The app's date-only format supports Gregorian years 0001 through 9999.                   |
| `csv.js`                | Parsing and normalising broker trade exports.                                            |
| `edge-map.js`           | Net P&L by weekday × entry time and best/worst setups, mistakes, emotions, symbols.      |
| `risk-limits.js`        | Daily loss / trades-per-day limits and monthly goal; the status that pauses live orders. |
| `trade-execution.js`    | Stop-loss, entry/exit times, partial exits and orders per side                           |
| `strategy-stages.js`    | Strategy stages: draft → backtested → paper → live → retired                             |
| `tradebook.js`          | Recognises fill-per-row broker tradebooks and pairs them into same-day round trips.      |
| `manual-invitations.js` | Zod schemas for private invitation links, shared by server and browser.                  |
| `market.js`             | NSE session helpers.                                                                     |
| `options.js`            | Black-Scholes prices and Greeks, option leg/strategy payoff, breakevens, presets.        |
| `order-plans.js`        | Order plans (frozen planning estimates)                                                  |
| `pnl.js`                | The single source of truth for what a trade earned.                                      |
| `risk-calculator.js`    | Position sizing and risk/reward maths with exact decimal arithmetic (paise).             |
| `spreadsheet-data.js`   | Keep decimal strings intact; spreadsheet date cells represent calendar dates.            |
| `strategy-evidence.js`  | Backtest evidence for strategies                                                         |
| `trade-export.js`       | Trade book CSV export (safe for spreadsheets).                                           |
| `types.js`              | Domain types shared across the app.                                                      |

### `shared/backtest/`

| File            | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `engine.js`     | A deterministic long-only backtest over real candles. |
| `indicators.js` | Indicator primitives.                                 |
