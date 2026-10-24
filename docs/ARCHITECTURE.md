# Architecture

Blank is a server-rendered Express application organised as Model–View–Controller.

## Request flow

```
browser ──► routes/web.js ──► middleware (session, CSRF, auth) ──► controllers/pages.controller.js
                                                                   └─► res.renderWorkspace(view)
                                                                        └─► views/layouts/workspace.ejs
                                                                             + views/pages/<page>.ejs
                                                                             + public/js/pages/<page>.js

browser fetch ──► routes/api.js ──► middleware ──► controllers/*.controller.js ──► services/* ──► models/*
```

- **Models** (`models/`) are Mongoose schemas. IDs are UUID strings so they match the identifiers
  the client and shared domain code already use. Monotonic `serverRevision` values come from the
  `Counter` collection.
- **Controllers** (`controllers/`) validate input (Zod) and translate between HTTP and services.
- **Services** (`services/`) hold business rules, grouped by area: `auth/` (accounts, sessions,
  TOTP), `journal/` (workspace CRUD with server-side trade economics, backup, weekly report),
  `market/` (Kite with Yahoo fallback, instrument master), `broker/` (Zerodha login flow, portfolio,
  live orders), `ai/` (OpenAI helpers, model configuration, usage limits, research archive),
  `admin/` (private invitations), `billing/` (Premium plan, membership, Razorpay), `platform/`
  (admin-managed API keys copied into `process.env`) and `maintenance/`. GridFS storage, mail and
  encryption helpers sit
  at the top level. See [CODE-MAP.md](CODE-MAP.md) for every file.
- **Views** (`views/`) are EJS templates. Every workspace page uses one layout
  (`layouts/workspace.ejs`) with the top bar, dock and command palette partials. The page's data is
  embedded once as JSON (`#page-data`) and read by its browser module.

## Browser modules

There is no bundler. Pages load native ES modules from `/js/...`, the universal domain code from
`/shared/...`, and an import map resolves `zod` to the package's small `zod/v3` build (the server
uses zod 4; shared schemas stick to the API both understand). Chart.js, jsPDF and
html-to-image are loaded as vendor scripts only on the pages that need them.

- `public/js/core/` — `dom.js` (`h()` element builder that always inserts text safely, cards,
  buttons, fields), `api.js` (fetch wrapper adding CSRF and session identity), `dialog.js`
  (accessible modals), `toast.js`, `theme.js`, `shell.js` (clock, menu, theme, sign-out),
  `command-palette.js` (⌘K palette and keyboard shortcuts), `format.js` (signed ₹ amounts),
  `stack-tables.js` (phone card layout for wide tables), `i18n.js` (English/Hindi text).
- `public/js/components/` — reusable widgets: trade form, broker portfolio, market chart, Chart.js
  wrappers, markdown renderer (marked + DOMPurify), strategy evidence panel, AI availability gate.
- `public/js/lib/` — client libraries: AI requests (streaming chat), quotes/broker calls, order plan
  store and cloud sync, research archive, import ledger, saved views, PDF export.
- `public/js/pages/` — one entry script per page; large pages keep their parts in a folder of the
  same name (see [CODE-MAP.md](CODE-MAP.md#browser-pages)).

## Domain code shared by server and browser (`shared/`)

P&L and charges (`pnl.js`), risk calculator, CSV/XLSX import parsing, business dates and report
periods, backtest engine and indicators, order-plan records, strategy evidence validation, AI
response schemas and the trade CSV export. Both sides import the same files, so a value the browser
previews is the value the server stores.

## Admin panel and Premium

The admin panel (`/admin`, `routes/admin.js`) is a separate area with its own sign-in page, layout
(`views/layouts/admin.ejs`, rendered with `res.renderAdmin`) and browser modules
(`public/js/admin/`). Its API lives under `/api/admin` behind `requireApiAdmin`; changes to keys,
money or access also need `requireAdminMfa` (an authenticator used in this session) and are written
to `AdminAuditLog`.

API keys saved in Integrations are stored in `PlatformSetting` (secrets encrypted) and copied into
`process.env` at start-up and every minute (`services/platform/settings.js`), so services keep
reading `process.env` and need no changes. A panel value overrides `.env`.

Premium (`services/billing/`) is off until the administrator switches billing on. Then
`requirePremium(feature)` answers 402 on Premium API routes, Premium pages render
`pages/upgrade.ejs`, and the scheduled jobs skip free members. Whether a member has Premium is
computed from `Subscription` dates on each request (trial end, paid-until from Razorpay webhooks,
admin grant), so nothing has to expire it.

## Data storage

Every collection with its indexes, retention, size per member and sensitive fields, plus backups
and scaling: [DATABASE.md](DATABASE.md).

| Collection(s)                                          | Purpose                                              |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `users`, `allowedusers`, `loginusernames`              | Members, invitations allow-list, optional usernames  |
| `sessions`                                             | Server-side sessions (connect-mongo)                 |
| `authtokens`, `manualinvitations`                      | Activation/recovery tokens, private invitation links |
| `trades`, `strategies`, `tradingrules`                 | Journal records                                      |
| `watchlistitems`, `chatmessages`                       | Watchlist and AI conversation                        |
| `accountsettings`                                      | Capital, charge rates, risk limits, preferences      |
| `papertrades`, `pricealerts`                           | Paper trading and price alerts                       |
| `liveorders`                                           | Audit log of live Zerodha orders and GTTs            |
| `pushsubscriptions`, `telegramlinks`                   | Push devices and linked Telegram chats               |
| `sharelinks`, `coachreviews`                           | Mentor read-only links, saved AI coach reviews       |
| `ratewindows`                                          | Rate-limit counters (expire automatically)           |
| `orderplanrecords`                                     | Append-only saved order plans and reviews            |
| `strategyevidences`, `…reviews`                        | Immutable backtest evidence and owner decisions      |
| `researchruns`, `aiusageevents`, …                     | AI research archive, usage limits, model config      |
| `brokerconnections`, `instruments`                     | Encrypted Kite/Dhan tokens, NSE instrument master    |
| GridFS `statements`, `voice-notes`, `tradeScreenshots` | Uploads, temporary audio, chart screenshots          |
