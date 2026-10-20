/**
 * Running the import row by row with a browser checkpoint, and closing a saved
 * batch.
 */
import { h, button } from '../../core/dom.js';
import { api, ApiError } from '../../core/api.js';
import { openModal } from '../../core/dialog.js';
import { notify } from '../../core/toast.js';
import {
  createImportBatch,
  clearImportBatch,
  importCounts,
  saveImportBatch,
} from '../../lib/import-ledger.js';
import { paint } from './paint.js';
import { reset } from './reading.js';
import { accountId, available, chargesFor, derived, recoveryError, state } from './shared.js';

let busy = false;

/** Each accepted row has one immutable payload and UUID. */
export async function runImport() {
  if (busy || state.readingFile || !accountId || !available || recoveryError) return;
  busy = true;
  state.importing = true;
  state.importError = null;
  paint();
  let working = state.batch;
  try {
    if (!working && state.mapping)
      working = await createImportBatch(
        accountId,
        state.fileName,
        derived().toImport,
        chargesFor,
        state.sourceDigest,
        state.mapping,
        state.importReference.trim(),
      );
  } catch {
    notify('Could not prepare stable import identities. Nothing was written.', 'error');
  }
  if (!working || working.ownerId !== accountId) {
    busy = false;
    state.importing = false;
    paint();
    return;
  }
  const checkpoint = (next) => {
    saveImportBatch(next);
    working = next;
    state.batch = next;
  };
  const withStatus = (index, status) => ({
    ...working,
    operations: working.operations.map((row, i) => (i === index ? { ...row, status } : row)),
  });
  try {
    checkpoint(working);
    for (let index = 0; index < working.operations.length; index += 1) {
      const operation = working.operations[index];
      if (operation.status === 'acknowledged') continue;
      // Persist unknown BEFORE contacting the server: a reload after commit but
      // before the response must reuse this exact row ID, never a replacement.
      checkpoint(withStatus(index, 'unknown'));
      try {
        await api('/api/trades/import', { method: 'POST', body: { trade: operation.trade } });
      } catch (error) {
        const status =
          error instanceof ApiError && error.payload?.outcome === 'failed' ? 'failed' : 'unknown';
        checkpoint(withStatus(index, status));
        throw error;
      }
      checkpoint(withStatus(index, 'acknowledged'));
      state.progress = importCounts(working).acknowledged;
      paint();
    }
    clearImportBatch(accountId);
    notify(
      `Imported ${working.operations.length} ${working.operations.length === 1 ? 'trade' : 'trades'}.`,
      'success',
    );
    state.batch = null;
    // Duplicate detection must see the newly imported rows.
    window.setTimeout(() => window.location.reload(), 600);
    reset();
  } catch (error) {
    const count = importCounts(working);
    const reason = error instanceof Error ? error.message : 'Could not complete the import.';
    const message = `Import stopped: ${count.acknowledged} of ${count.total} acknowledged and kept; ${count.failed} failed; ${count.unknown} unknown; ${count.pending} not attempted. Retry this batch safely. ${reason}`;
    state.importError = message;
    notify(message, 'error');
  } finally {
    busy = false;
    state.importing = false;
    paint();
  }
}

/**
 * Asks for confirmation, then deletes the saved import checkpoint from browser storage
 * and resets the page. Saved trades are not touched.
 */
export function openCloseBatch() {
  openModal({
    title: 'Close saved import?',
    content: (close) =>
      h(
        'div',
        {},
        h(
          'p',
          { class: 'mb-4 text-sm text-muted' },
          `Acknowledged trades remain saved. Unknown rows may already be saved. To retry safely after closing, use the exact same CSV content or selected workbook sheet, column mapping and import reference (${state.batch?.reference || 'blank/default'}). Changing any of these starts a different operation and can create another copy. No existing trade will be deleted.`,
        ),
        h(
          'div',
          { class: 'flex gap-2' },
          button('Keep checkpoint', { variant: 'outline', onclick: close }),
          button('Close checkpoint', {
            onclick: () => {
              try {
                clearImportBatch(accountId);
                state.batch = null;
                state.importError = null;
                close();
                reset();
              } catch {
                notify(
                  'Could not close the saved import. Browser storage is unavailable.',
                  'error',
                );
              }
            },
          }),
        ),
      ),
  });
}
