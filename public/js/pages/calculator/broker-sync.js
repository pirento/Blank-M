/**
 * Syncs the trading capital from the linked broker balance.
 */
import { formatIstDateTime } from '../../core/dom.js';
import { fetchBrokerBalance } from '../../lib/quotes.js';
import { paintEstimate, paintSync } from './painting.js';
import { fields, inputs, state } from './shared.js';

/**
 * Reads the broker's available balance and copies it into account size and available
 * capital; from then on the planning capital follows the broker (read-only, refreshed with the
 * same button). Skips the update if the user edited those fields while the request was out.
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
    // The broker's money is what it says: add funds in the broker, then refresh here.
    state.brokerCapital = true;
    inputs.accountSize.readOnly = true;
    state.syncMessage = `${balance.label} INR balance read ${formatIstDateTime(balance.fetchedAt)} IST. Planning capital now follows your broker: add funds in ${balance.label}, then refresh. You can still plan with less in available capital.`;
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
