/**
 * Syncs the trading capital from the linked Zerodha balance.
 */
import { formatIstDateTime } from '../../core/dom.js';
import { fetchBrokerBalance } from '../../lib/quotes.js';
import { paintEstimate, paintSync } from './painting.js';
import { fields, inputs, state } from './shared.js';

/**
 * Reads the Zerodha available balance and copies it into account size and available
 * capital. Skips the update if the user edited those fields while the request was out.
 */
export async function syncBalance() {
  if (state.syncing) return;
  state.syncing = true;
  state.syncMessage = '';
  paintSync();
  const revision = state.capitalRevision;
  try {
    const balance = await fetchBrokerBalance();
    if (!Number.isFinite(balance.liveBalance) || balance.liveBalance <= 0)
      throw new Error(
        'The broker returned no positive available balance. Manual capital was preserved.',
      );
    if (revision !== state.capitalRevision) {
      state.syncMessage =
        'Balance received, but your capital fields changed while reading it. Sync again to use the broker balance.';
      return;
    }
    state.capitalRevision += 1;
    fields.accountSize = String(balance.liveBalance);
    fields.availableCapital = String(balance.liveBalance);
    inputs.accountSize.value = fields.accountSize;
    inputs.availableCapital.value = fields.availableCapital;
    state.syncMessage = `Zerodha INR balance read ${formatIstDateTime(balance.fetchedAt)} IST. This snapshot does not verify margin for a planned order.`;
  } catch (error) {
    state.syncMessage =
      error instanceof Error
        ? error.message
        : 'Could not read broker balance. Manual capital was preserved.';
  } finally {
    state.syncing = false;
    paintSync();
    paintEstimate();
  }
}
