# Developer guide

How to find your way around Blank, follow a request end to end, and add to it the way the existing
code does. For where each file lives see [CODE-MAP.md](CODE-MAP.md); for the big picture see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Read these first (30 minutes)

| Order | File                                  | Why                                                            |
| ----- | ------------------------------------- | -------------------------------------------------------------- |
| 1     | `app.js`                              | How a request is handled: security, sessions, routes, errors   |
| 2     | `routes/api.js`, `routes/web.js`      | Every URL the app answers, and which controller handles it     |
| 3     | `controllers/workspace.controller.js` | A typical controller: thin, calls one service per request      |
| 4     | `services/journal/workspace.js`       | A typical service: validation, business rules, database writes |
| 5     | `shared/pnl.js`                       | The money rules (P&L, charges) shared by server and browser    |
| 6     | `public/js/core/dom.js`               | How the browser builds pages (`h()`, cards, buttons, fields)   |
| 7     | `public/js/components/trade-form.js`  | A typical browser component talking to the API                 |

Every file starts with a comment saying what it is for, and every exported function has a comment
saying what it does. Read those before the code.

## Where code goes

| Folder                  | Puts here                                                    | Never puts here                    |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------- |
| `routes/`               | URL → controller wiring, auth guard per route                | Logic                              |
| `controllers/`          | Read the request, call a service, send JSON or render a page | Database queries, business rules   |
| `services/<area>/`      | Business rules, validation, database and external API calls  | `req`/`res`                        |
| `models/`               | Mongoose schemas and indexes                                 | Behaviour beyond schema hooks      |
| `shared/`               | Pure domain logic used by both server and browser            | Database, DOM, network             |
| `middleware/`           | Cross-cutting request steps (session, CSRF, auth, logging)   | Feature logic                      |
| `views/`                | EJS layout and page skeletons                                | Data fetching                      |
| `public/js/core/`       | Browser helpers every page uses (DOM, API, dialogs, toasts)  | Page-specific code                 |
| `public/js/pages/`      | One entry file per page; big pages get a folder of parts     | Code another page needs (→ `lib/`) |
| `public/js/lib/`        | Browser logic without UI (API clients, storage, sync)        | DOM building                       |
| `public/js/components/` | Reusable UI pieces (trade form, charts, dialogs)             | Page wiring                        |
| `tests/`                | `shared/` unit, `server/` HTTP integration, `e2e/` browser   | —                                  |

## One request end to end: logging a trade

1. **Browser** — `public/js/components/trade-form.js` validates the form with `shared/pnl.js`
   (`validateTradeInput`), shows the P&L preview, then calls
   `api('/api/trades', { method: 'POST', body })` (`public/js/core/api.js` adds the CSRF token).
2. **Route** — `routes/api.js`: `router.post('/trades', requireApiAuth, wrap(workspace.createTrade))`.
   `requireApiAuth` (`middleware/auth.js`) rejects anyone not signed in; `wrap` sends thrown errors
   to `middleware/errors.js`.
3. **Controller** — `controllers/workspace.controller.js` `createTrade` passes the member ID and
   body to the service and answers `201 { trade }`.
4. **Service** — `services/journal/workspace.js` `createTrade` loads the member's charge settings,
   validates everything again (`tradeDocument`), computes gross P&L and charges with `shared/pnl.js`
   and saves a `Trade`.
5. **Model** — `models/Trade.js` stores it; a schema hook stores `netPnl = grossPnl − charges`.
6. **Back in the browser** — the form calls `onSubmitted(trade)` and the page repaints.

Pages work the same way but render HTML: `routes/web.js` lists every page in `WORKSPACE_PAGES`
(path, view, which data it needs); `controllers/pages.controller.js` loads that data and calls
`res.renderWorkspace()`; the page's browser module reads it from `#page-data` with `pageData()`.

## Conventions

- **Errors:** throw `new HttpError(message, status)` (`services/errors.js`). The message is shown to
  the member, so write it for them. Unexpected errors become a generic 500 and are logged with a
  request ID.
- **Validation:** at every trust boundary (request body, uploads, broker responses), with Zod or the
  shared validators. The browser validates too, but the server never trusts it.
- **Money:** rupees as numbers, settled to paise in `shared/pnl.js`; never compute charges anywhere
  else.
- **Dates:** the market runs on IST. Use `todayInIst()` / `toIst()` from `shared/market.js`, never
  the server clock's date.
- **Secrets:** only in `.env`. Broker tokens and authenticator secrets are encrypted
  (`services/crypto.js`). Logs never contain tokens, passwords or request bodies.
- **Ownership:** every query on member data filters by `userId`.
- **Comments:** explain why, not what the line already says. Each file starts with a short header.
- **Style:** Prettier and ESLint decide formatting; run them before committing.

## Common tasks

**Add an API endpoint:** service function in `services/<area>/` → controller handler → route in
`routes/api.js` with `requireApiAuth` (and a CSRF exemption only for non-browser callers such as
webhooks) → test in `tests/server/`.

**Add a page:** `views/pages/<name>.ejs` + `public/js/pages/<name>.js` → entry in
`WORKSPACE_PAGES` (`routes/web.js`) → nav item in `config/nav.js` → add it to `WORKSPACE_PAGES` in
`tests/e2e/helpers.js` so the smoke test opens it.

**Add a member setting:** field in `models/AccountSettings.js` → read/validate in
`services/journal/account-settings.js` → a card in `public/js/pages/settings/` mounted from
`public/js/pages/settings.js` → keep it in backups (`services/journal/backup.js`).

**Add a scheduled job:** an endpoint under `/api/maintenance/` that checks `CRON_SECRET`
(`services/maintenance/authorize.js`) and is listed in `CSRF_EXEMPT` (`middleware/security.js`), a
script in `scripts/` that calls it, and a line in `deploy/crontab.example`.

## Checks before a commit

```bash
pnpm run lint
pnpm run format:check
pnpm test            # unit + server integration (in-memory MongoDB)
pnpm run build
pnpm run test:e2e    # browser tests
```
