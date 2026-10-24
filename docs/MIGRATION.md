# Migration notes: React/TypeScript + Supabase → Express MVC + MongoDB + EJS

This rewrite keeps the application's behaviour and rules while replacing the platform underneath.

## What changed

| Before                                    | Now                                                          |
| ----------------------------------------- | ------------------------------------------------------------ |
| TypeScript (`.ts`/`.tsx`), Vite bundle    | Plain JavaScript ES modules, no client build (Tailwind only) |
| React single-page app, React Router       | Server-rendered EJS pages + one browser module per page      |
| Supabase Postgres, RLS, SQL RPC functions | MongoDB + Mongoose; ownership enforced in every query        |
| Supabase Auth (JWT, GoTrue MFA)           | Express sessions in MongoDB, bcrypt, built-in TOTP           |
| Supabase Realtime                         | Request/response with immediate local updates after writes   |
| Supabase Storage buckets                  | MongoDB GridFS buckets `statements` and `voiceNotes`         |
| Vercel Functions + `vercel.json` cron     | One Express server; `scripts/maintenance-voice-notes.js`     |
| pgvector journal search                   | Embeddings stored in MongoDB, cosine similarity in Node      |
| Recharts                                  | Chart.js                                                     |
| react-markdown                            | marked + DOMPurify                                           |

## What did not change

The domain functions were converted from TypeScript to JavaScript by removing type annotations
only; their logic is identical and their original unit tests run against them (`tests/shared/`).
This covers P&L and charges, the risk calculator, CSV/Excel import parsing and duplicate
detection, business dates and report periods, the backtest engine, order-plan validation, strategy
evidence validation, AI response schemas, saved views and the import ledger.

API paths, request and response shapes, validation messages and safety rules (append-only plans
and evidence, optimistic revisions, owner checks, rate limits, CSRF and session identity checks)
were kept so the browser modules behave as before.

## Functions completed in this rewrite

Pieces that previously depended on Supabase SQL functions or were not implemented in the server
were implemented on MongoDB: invitations and activation email, private invitation links, account
revocation with session termination, username claims, authenticator enrolment/verification/removal,
order-plan cloud history, strategy evidence and reviews, research run archive, AI usage limits and
model configuration, broker connection state, instrument master refresh, statement/voice-note
storage and their scheduled cleanup, and the trade-book CSV export helper.

## Moving existing data

Supabase data is not migrated automatically. If you need it, export each table to JSON/CSV and
import it into the matching collection (see the model files for field names): rename `id` to `_id`,
map `user_id` → `userId`, `trade_date` → `tradeDate`, `created_at` → `createdAt`. Unless you export
Supabase Auth password hashes yourself, members set a new password (use _Forgot password_ or a new
invitation). Authenticators must be enrolled again because their secrets are not exportable.
