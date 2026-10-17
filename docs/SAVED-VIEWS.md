# Saved transaction views

Saved view names and searches may contain private notes. Views remain browser-local, but Blank only loads and updates the signed-in, active account's own entries. They are not synced to the server or another device.

## Current storage and account changes

- Each account uses `blank_transaction_views:v1:<encoded account ID>`, with the account ID encoded using `encodeURIComponent`.
- Its JSON envelope contains `version: 1`, `ownerId`, and a `views` array. The reader checks both version and owner before validating the entries. At most 12 valid views are loaded or saved, preserving their order.
- Signing out, switching accounts, entering password recovery, or losing active access unmounts the transaction page's account boundary. Active search/date/direction/outcome filters, unsaved view names, dialogs, sort and selection state are discarded before the next account's page is shown. A retained save handler from the old page is rejected.
- Save notifications omit view names and search text to minimize private details in transient feedback.
- Signing out does not remove that account's saved views. Signing into the same account later loads its saved choices, with no filter automatically applied. Another account cannot see them through the ledger UI.
- Malformed, wrong-owner and unsupported payloads are ignored without deleting their bytes. Explicitly saving or deleting a view replaces only the current owner's entry; unrelated browser preferences are untouched.
- If browser storage is blocked or full, filtering and session-only view changes still work. A failed persistence attempt is reported. Session-only changes disappear when the page is unmounted or reloaded.

This is prevention of accidental cross-account UI carryover, not encryption or a secure vault. Someone with access to the browser profile, developer tools, or same-origin scripts may still read local storage. Use separate browser profiles on shared devices and avoid putting sensitive secrets into filter names or searches.

## Legacy preservation and recovery

Older builds used one unowned array at `blank_transaction_views`. There is no reliable evidence of which account created those names or search terms, and it may contain entries from more than one account.

The current reader never reads, displays, imports, rewrites, or removes that legacy key. It is preserved in place as unclaimed data. No account, including the first account to sign in after upgrading, receives it automatically. Saving current views creates a separate owner-scoped entry without changing the original bytes.

There is no automatic legacy recovery/import UI. If old views are needed, the person who owns the browser profile and can establish ownership of each view can preserve a local backup and recreate only their own filters in Blank while signed into the correct account. Do not expose the entire legacy payload to the currently signed-in user merely because they can sign in. If ownership cannot be established, leave the legacy data unclaimed rather than assign it. Do not include legacy names or search text in support tickets or logs. Clearing site data or moving to another browser can lose both legacy and current browser-local views.

## Deterministic regression coverage

`tests/shared/views.test.js` checks owner-isolated reloads, missing owners, distinct owner keys, legacy-byte preservation, malformed and mismatched envelopes, limits, and storage-denial handling.

The trade book page (`public/js/pages/transactions.js`) reads and writes views only for the account embedded in the server-rendered page, so a page rendered for one account can never write another account's views.

## Account-scoped feedback

Every page is rendered for exactly one signed-in account, and API requests carry that page's session identity; a request queued by a previous sign-in is rejected (HTTP 409). Notifications live only in the current page and are discarded on navigation or sign-out.
