# Database

Blank keeps everything in one MongoDB database (Mongoose models in `models/`, the session store
and GridFS buckets alongside). This page lists every collection, what it costs per member, how
long it is kept and what is sensitive, then covers indexes in production, backups and scaling.

## Rules that apply to every collection

- **Member data is filtered by `userId`.** Every member-scoped index starts with `userId`, so one
  member's query never reads another member's rows, and the indexes stay useful when there are
  thousands of members.
- **Journal data is kept.** Trades, strategies, rules, watchlist, settings, broker connections,
  saved plans, backtest evidence and live orders never expire. Only logs, one-time tokens and
  caches have a TTL (MongoDB deletes them in the background, about once a minute).
- **Nothing grows inside one document without a cap** (MongoDB's limit is 16 MB per document):
  strategy stage history ≤ 50 entries, authenticators ≤ 10 per account (≤ 3 unfinished), partial
  exits per trade and tags per trade are validated, the AI chat keeps the last 1,000 messages per
  member and coach reviews the last 100.
- **Secrets are never stored in plain text** (see [Sensitive data](#sensitive-data)).

## Collections

Sizes are rough figures for an active member, to plan disk and RAM, not limits.

| Collection                | Stores                                                                       | Key indexes                                                                                                   | Retention                                           | Size per member                     |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| `users`                   | Account, password hash, role, encrypted authenticator secrets                | `email` unique, `googleSubject` unique (partial)                                                              | Kept                                                | ~1 KB                               |
| `allowedusers`            | Invitation allow-list (email → role, accepted account)                       | `_id` = email, `authUserId` unique (partial)                                                                  | Kept                                                | ~0.2 KB                             |
| `loginusernames`          | Optional sign-in usernames (reserved for ever)                               | `userId` unique (partial)                                                                                     | Kept                                                | ~0.1 KB                             |
| `manualinvitations`       | Private invitation links (token digest only)                                 | `email` unique, `tokenHash` unique                                                                            | Kept (admin audit)                                  | admin only                          |
| `authtokens`              | Activation / recovery links (SHA-256 digest only)                            | `tokenHash` unique, `userId+purpose`, TTL `expiresAt`                                                         | **7 days after expiry**                             | tiny                                |
| `sessions`                | Server sessions (connect-mongo, no model)                                    | TTL `expires` (connect-mongo), `session.auth.userId+sessionId` (`config/database.js`)                         | **Expires with the session (7 days, rolling)**      | ~1 KB per device                    |
| `ratewindows`             | Rate-limit counters (hashed keys only)                                       | TTL `expiresAt`                                                                                               | **Deleted when the window ends**                    | tiny                                |
| `accountsettings`         | Capital, charge rates, risk limits, notification opt-ins                     | `_id` = user id; partial `weeklyReportSentFor`, `dailyAutoImportFor`, `premarketPlanFor` for the opted-in     | Kept                                                | ~1–2 KB                             |
| `trades`                  | Journal round trips (P&L, charges, tags, notes, execution)                   | `userId+tradeDate+_id`, `userId+strategyId`                                                                   | Kept                                                | ~1 KB per trade (notes up to 20 KB) |
| `strategies`              | Written strategies with stage history (≤ 50)                                 | `userId+tradeDate+_id`                                                                                        | Kept                                                | ~2–5 KB each                        |
| `tradingrules`            | Rule book                                                                    | `userId+createdAt+_id`                                                                                        | Kept                                                | ~0.5 KB each                        |
| `watchlistitems`          | Watchlist symbols                                                            | `userId+symbol` unique, `userId+addedAt+_id`                                                                  | Kept                                                | ~0.1 KB each                        |
| `chatmessages`            | AI chat history                                                              | `userId+createdAt+_id`                                                                                        | **Last 1,000 per member** (trimmed on each new)     | ≤ ~2 MB                             |
| `coachreviews`            | Saved AI coach reviews                                                       | `userId+createdAt`, `userId+period+to`                                                                        | **Last 100 per member**                             | ≤ ~300 KB                           |
| `researchruns`            | AI research runs with their NIFTY 500 universe snapshot                      | `userId+requestId` unique, `userId+sequence`, TTL `startedAt`                                                 | **180 days**                                        | ~60 KB per run                      |
| `aiusageevents`           | AI usage metadata for hourly limits (never prompts)                          | `userId+createdAt`, TTL `createdAt`                                                                           | **90 days**                                         | ~0.2 KB per request                 |
| `journalembeddings`       | Search vectors for the member's recent journal                               | `userId+sourceType+sourceId` unique                                                                           | Rebuilt; orphans removed (≤ ~900 rows)              | ≤ ~18 MB (largest per member)       |
| `aiconfigurations`        | Model routing singleton                                                      | `_id`                                                                                                         | Kept                                                | one row                             |
| `orderplanrecords`        | Append-only order plans and reviews                                          | `userId+recordKey` unique, `userId+serverRevision`, `serverRevision` unique                                   | Kept                                                | ~1–2 KB each                        |
| `strategyevidences`       | Immutable backtest evidence                                                  | `userId+serverRevision`, `serverRevision` unique                                                              | Kept                                                | up to ~500 KB each                  |
| `strategyevidencereviews` | Owner decisions on evidence                                                  | `userId+evidenceId+serverRevision`                                                                            | Kept                                                | ~1 KB each                          |
| `counters`                | Monotonic sequences                                                          | `_id`                                                                                                         | Kept                                                | a few rows                          |
| `liveorders`              | Live order audit log (financial record)                                      | `userId+planId` unique (partial), `userId+tradingDate`, `userId+createdAt`, auto-GTT scan (partial `autoGtt`) | Kept                                                | ~0.6 KB each                        |
| `papertrades`             | Simulated trades                                                             | `userId+status+openedAt`, `userId+status+closedAt`, `status`                                                  | Kept (≤ 50 open)                                    | ~0.5 KB each                        |
| `pricealerts`             | Price alerts                                                                 | `userId+status+createdAt`, `status`, TTL `triggeredAt`                                                        | Active: kept (≤ 50); **triggered: 90 days**         | ~0.3 KB each                        |
| `pushsubscriptions`       | Web Push devices                                                             | `endpoint` unique, `userId`                                                                                   | Kept (≤ 10); dead endpoints removed on send         | ~0.5 KB each                        |
| `telegramlinks`           | Linked Telegram chat                                                         | `userId` unique, `chatId` unique                                                                              | Kept until unlinked                                 | ~0.2 KB                             |
| `telegramlinkcodes`       | One-time link codes (digest only)                                            | TTL `expiresAt`                                                                                               | **Deleted at expiry (10 minutes)**                  | tiny                                |
| `sharelinks`              | Mentor read-only links (token digest only)                                   | `tokenHash` unique, `userId+createdAt`, TTL `expiresAt`                                                       | **30 days after expiry** (links last ≤ 90 days)     | ~0.3 KB each                        |
| `brokerconnections`       | Encrypted broker access tokens, one per member and provider                  | `userId+provider` unique                                                                                      | Kept until disconnected                             | ~0.5 KB per broker                  |
| `brokeroauthstates`       | One-time broker login markers                                                | TTL `expiresAt`                                                                                               | **1 day after expiry**                              | tiny                                |
| `instruments`             | NSE instrument master (shared, not per member)                               | `exchange+tradingSymbol`, `instrumentToken` unique (sparse)                                                   | Refreshed                                           | ~3 MB in total                      |
| GridFS `statements`       | Uploaded statements/charts for AI analysis (≤ 10 MB each)                    | GridFS `filename+uploadDate`                                                                                  | **7 days** (same daily job)                         | depends on uploads                  |
| GridFS `voiceNotes`       | Temporary voice notes                                                        | GridFS `filename+uploadDate`                                                                                  | **24 hours** (`scripts/maintenance-voice-notes.js`) | tiny                                |
| GridFS `tradeScreenshots` | One chart screenshot per trade (≤ 5 MB)                                      | GridFS `filename+uploadDate`                                                                                  | Deleted with the trade or screenshot                | ≤ 5 MB per trade                    |
| `platformsettings`        | Admin panel API keys/switches (secrets encrypted) and the Premium plan       | `_id` = setting key                                                                                           | Kept                                                | platform-wide, a few KB             |
| `adminauditlogs`          | Who changed what in the admin panel (never secret values)                    | `createdAt` TTL                                                                                               | **2 years**                                         | admin only                          |
| `subscriptions`           | Premium per member: trial end, paid-until, admin grant, Razorpay id/status   | `_id` = user id, `razorpaySubscriptionId` unique (partial), `razorpayStatus`                                  | Kept                                                | ~0.3 KB                             |
| `payments`                | Razorpay payments (financial record)                                         | `_id` = payment id, `userId+paidAt`, `paidAt`                                                                 | Kept                                                | ~0.2 KB per month paid              |
| `billingevents`           | Razorpay webhook event ids already applied (idempotency)                     | `_id` = event id, `receivedAt` TTL                                                                            | **90 days**                                         | tiny                                |
| `trialclaims`             | One free trial per person: digest of the canonical email (no address stored) | `_id` = digest                                                                                                | Kept (also after account deletion)                  | tiny                                |

A typical member needs **1–5 MB** of documents plus up to ~18 MB of search vectors and whatever
files they upload; 5,000 members fit comfortably in tens of gigabytes.

## Sensitive data

| Data                                            | Protection                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker access tokens (`brokerconnections`)      | AES-256-GCM with `BROKER_TOKEN_ENCRYPTION_KEY` (`services/crypto.js`); only ciphertext, IV, tag                                                                                                       |
| Authenticator (TOTP) secrets (`users.factors`)  | AES-256-GCM with a key derived from `MFA_ENCRYPTION_KEY` (or `SESSION_SECRET`)                                                                                                                        |
| Passwords (`users.passwordHash`)                | bcrypt hash only                                                                                                                                                                                      |
| Emailed, invitation, mentor and Telegram tokens | SHA-256 digests only (`authtokens`, `manualinvitations`, `sharelinks`, `telegramlinkcodes`)                                                                                                           |
| Rate-limit keys (`ratewindows`)                 | Opaque hashes; no IP address or email                                                                                                                                                                 |
| Sessions (`sessions`)                           | Server-side only; whoever can read the database can hijack a session, so protect database access                                                                                                      |
| Journal (trades, notes, chat, settings)         | Personal financial data, not encrypted field by field: rely on encryption at rest (Atlas does it by default; on a VPS use an encrypted disk) and keep MongoDB bound to localhost or a private network |

Never put an API key, token or password into the database in plain text: encrypt it with
`services/crypto.js` (or store a digest when it only needs to be compared), and keep the keys in
`.env`, never in the database or the repository.

## Indexes in production

`config/database.js` connects with `autoIndex: true`, so on every start Mongoose runs
`createIndex` for each index declared in `models/` (and `config/database.js` adds the session
index). For this app's size that is acceptable: building is idempotent and fast on collections of
this size, and MongoDB 4.2+ builds do not block reads and writes for long. Things to know:

- **New TTL indexes start deleting immediately.** The first start after deploying this change
  removes triggered alerts older than 90 days, research runs older than 180 days and share links
  expired more than 30 days ago.
- **Indexes removed from a model are not dropped.** The redundant `strategies` `userId_1` index
  (covered by `userId+tradeDate+_id`) can be dropped by hand:
  `db.strategies.dropIndex('userId_1')`.
- **Changing an existing TTL** (its `expireAfterSeconds`) needs
  `db.runCommand({ collMod: '<collection>', index: { keyPattern: {…}, expireAfterSeconds: N } })`;
  editing the model alone makes `createIndex` fail with an options conflict (logged, not fatal).
- On a very large collection, build a new index in a quiet hour, or create it by hand first
  (`db.<collection>.createIndex(…)`) so the start-up call finds it already there.
- `tests/server/indexes.test.js` checks that the important indexes and TTLs exist.

## Backup and restore

- **Daily server backup:** `deploy/backup-mongo.sh` (installed by `deploy/setup-vps.sh`) runs
  `mongodump --gzip --archive` into `/srv/blank/backups`, keeps 14 days, and with `BACKUP_REMOTE`
  copies each archive off the server with rclone (30 days kept; use an encrypted `crypt` remote).
  `deploy/health-check.sh` alerts when no backup has succeeded for a day.
- **Restore everything:** `mongorestore --uri="$MONGODB_URI" --gzip --archive=<file> --drop`. Indexes
  are recreated from the dump.
- **Test a restore** every month into a scratch database instead of the live one:
  `mongorestore --uri="$MONGODB_URI" --gzip --archive=<file> --nsFrom='blank.*' --nsTo='blank_restore.*'`
  (use your database name), check a member's trades, then drop the scratch database.
- **Keep the keys with the backup, but apart from it.** Broker tokens and authenticator secrets in
  a dump can only be decrypted with the same `BROKER_TOKEN_ENCRYPTION_KEY` and
  `MFA_ENCRYPTION_KEY`/`SESSION_SECRET`; without them members must reconnect brokers and re-enrol
  authenticators. Store the `.env` in a password manager, not next to the archives.
- A dump contains personal financial data and password hashes: treat it like the database.
- **One member:** Settings → Backup exports and restores that member's own data as JSON
  (`services/journal/backup.js`).
- **On MongoDB Atlas** use Cloud Backup (snapshots with point-in-time restore) instead of, or as
  well as, `mongodump`.

## Scaling

- **Thousands of members:** one MongoDB server is enough. Give it RAM for the indexes plus the hot
  data (the WiredTiger cache uses about half the RAM); watch for slow queries with
  `db.setProfilingLevel(1, { slowms: 100 })` or Atlas Performance Advisor, and check
  `db.<collection>.aggregate([{ $indexStats: {} }])` for unused indexes.
- **Before taking payments:** move to a three-node **replica set** (Atlas M10 or larger, or your own)
  for automatic failover and point-in-time backups. Multi-document transactions also need one.
  Only `MONGODB_URI` changes.
- **Sharding** is only worth it when one replica set can no longer hold the data or the writes
  (roughly beyond 1–2 TB or sustained write saturation), far beyond thousands of members. Every
  member query filters by `userId`, so `{ userId: 'hashed' }` would be the shard key for member
  collections.
- **Connections:** each app process keeps a Mongoose pool (100 by default). With PM2 in cluster mode
  or several servers, keep processes × pool under the server's connection limit.

## Known follow-ups

- Most workspace pages load all of a member's trades (the balance and statistics need them). This
  is fine up to roughly 10,000 trades per member; beyond that, compute the balance with an
  aggregation and page the transactions list.
- GridFS `statements` (files uploaded for AI analysis) are deleted after 7 days by the daily
  `scripts/maintenance-voice-notes.js` job. Do not add a TTL index to `statements.files`: it would
  leave the file chunks behind.
- `strategyevidences` (up to ~500 KB each) and `orderplanrecords` are append-only by design and
  have no per-member cap.
