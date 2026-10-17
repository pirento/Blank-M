/** Settings page — capital preferences. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  input,
  label,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatCurrency,
  render,
  formatIstDateTime,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { fetchBrokerBalance } from '../../lib/quotes.js';
import { available, settings, statusLine } from './shared.js';

/**
 * Mounts the planning capital card: validates and saves the opening balance via
 * PUT /api/settings, or fills the field from the broker balance without saving it.
 */
export function mountCapital() {
  const state = { busy: false, reading: false, message: '' };
  const capital = input({
    id: 'planning-capital',
    inputmode: 'decimal',
    value: String(settings.openingBalance),
    disabled: !available,
  });
  const saveButton = button(t('Save planning capital'));
  const readButton = button(t('Read broker balance'), { variant: 'outline' });
  const messageSlot = h('div');
  const paint = () => {
    capital.disabled = saveButton.disabled = readButton.disabled = state.busy || !available;
    saveButton.textContent = state.busy && !state.reading ? 'Saving…' : 'Save planning capital';
    readButton.textContent = state.reading ? 'Reading broker balance…' : 'Read broker balance';
    render(messageSlot, statusLine(state.message));
  };
  saveButton.addEventListener('click', async () => {
    if (state.busy || !available) return;
    const raw = capital.value.trim();
    const value = Number(raw);
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(raw) ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value * 100 > Number.MAX_SAFE_INTEGER
    ) {
      state.message = 'Enter a positive planning capital with at most two decimal places.';
      paint();
      return;
    }
    Object.assign(state, { busy: true, message: '' });
    paint();
    try {
      await api('/api/settings', { method: 'PUT', body: { openingBalance: value } });
      state.message = 'Manual planning capital saved. Broker funds are unchanged.';
    } catch (error) {
      state.message = errorMessage(error, 'Could not save planning capital.');
    } finally {
      state.busy = false;
      paint();
    }
  });
  readButton.addEventListener('click', async () => {
    if (state.busy || !available) return;
    Object.assign(state, { busy: true, reading: true, message: '' });
    paint();
    try {
      const result = await fetchBrokerBalance();
      if (result.liveBalance <= 0)
        throw new Error('Broker balance is not positive. Manual planning capital was not changed.');
      capital.value = result.liveBalance.toFixed(2);
      state.message = `Broker balance ${formatCurrency(result.liveBalance)} read at ${formatIstDateTime(result.fetchedAt)} IST. Save planning capital to apply it.`;
    } catch (error) {
      state.message = errorMessage(error, 'Could not read broker balance.');
    } finally {
      Object.assign(state, { busy: false, reading: false });
      paint();
    }
  });
  render(
    $('[data-capital]'),
    card(
      { className: 'settings-capital' },
      cardHeader('', cardTitle(t('Capital preferences'))),
      cardContent(
        'space-y-4',
        h(
          'div',
          { class: 'max-w-md' },
          label(t('Manual planning capital (₹)'), 'planning-capital'),
          capital,
        ),
        h('div', { class: 'flex flex-wrap gap-3' }, saveButton, readButton),
        h(
          'p',
          { class: 'text-sm text-muted' },
          'Manual planning capital never changes broker funds. Live balance is read only on request from your verified Zerodha account.',
        ),
        available ? null : statusLine(t('Saved planning capital could not be loaded.')),
        messageSlot,
      ),
    ),
  );
  paint();
}
