/**
 * "Add today's fills to journal": previews today's Zerodha or Dhan fills paired into
 * round trips and adds the chosen ones as journal trades. The server re-reads
 * the fills itself; this dialog only sends which round trips to add.
 */
import { signedCurrency as signed } from '../core/format.js';
import { t } from '../core/i18n.js';
import { h, button, cn, formatCurrency } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify } from '../core/toast.js';

const BROKERS = {
  kite: { label: 'Zerodha', path: '/api/kite/fills' },
  dhan: { label: 'Dhan', path: '/api/dhan/fills' },
};

/** @param {{ onAdded: (trades: object[]) => void, broker?: 'kite' | 'dhan' }} options */
export function openFillsToJournal({ onAdded, broker = 'kite' }) {
  const source = BROKERS[broker];
  openModal({
    title: t('Add today’s fills to journal'),
    description: t(
      'Fills are paired into round trips (flat to flat). Charges use your configured rates.',
    ),
    wide: true,
    content: (close) => {
      const body = h(
        'div',
        { class: 'space-y-4' },
        h(
          'p',
          { role: 'status', class: 'text-sm text-muted' },
          `Reading today’s fills from ${source.label}…`,
        ),
      );
      void load(body, close, onAdded, source);
      return body;
    },
  });
}

async function load(body, close, onAdded, source) {
  let preview;
  try {
    preview = await api(source.path, { timeout: 60_000 });
  } catch (error) {
    body.replaceChildren(
      h(
        'p',
        { role: 'alert', class: 'text-sm text-negative' },
        errorMessage(error, 'Could not read fills.'),
      ),
    );
    return;
  }
  const chosen = new Set(
    preview.candidates
      .filter((trip) => !trip.alreadyInJournal && !trip.problem)
      .map((trip) => trip.id),
  );
  const addButton = button('', { className: 'flex-1' });
  const paintButton = () => {
    addButton.textContent = chosen.size
      ? `Add ${chosen.size} ${chosen.size === 1 ? 'trade' : 'trades'} to journal`
      : 'Nothing selected';
    addButton.disabled = chosen.size === 0;
  };
  const row = (trip) => {
    const blocked = trip.alreadyInJournal || Boolean(trip.problem);
    const box = h('input', {
      type: 'checkbox',
      checked: chosen.has(trip.id),
      disabled: blocked,
      'aria-label': `Add the ${trip.symbol} ${trip.type.toLowerCase()} round trip`,
      class: 'focus-ring h-4 w-4 accent-[var(--color-accent)]',
      onchange: (event) => {
        if (event.target.checked) chosen.add(trip.id);
        else chosen.delete(trip.id);
        paintButton();
      },
    });
    return h(
      'tr',
      { class: cn('border-b border-line last:border-0', blocked && 'text-muted') },
      h('td', { class: 'py-2 pr-2' }, box),
      h(
        'td',
        { class: 'py-2 pr-3' },
        h('span', { class: 'font-medium text-fg' }, trip.symbol),
        h(
          'span',
          { class: 'ml-2 text-xs text-muted' },
          `${trip.type} · ${trip.product} · ${trip.fills} fills`,
        ),
        trip.alreadyInJournal ? h('div', { class: 'text-xs' }, 'Already in your journal') : null,
        trip.problem ? h('div', { class: 'text-xs text-negative' }, trip.problem) : null,
      ),
      h('td', { class: 'py-2 pr-3 text-right' }, trip.quantity.toLocaleString('en-IN')),
      h('td', { class: 'py-2 pr-3 text-right' }, `${trip.entryPrice} → ${trip.exitPrice}`),
      h('td', { class: 'py-2 pr-3 text-right' }, formatCurrency(trip.charges)),
      h(
        'td',
        {
          class: cn(
            'py-2 text-right font-medium',
            trip.pnl >= 0 ? 'text-positive' : 'text-negative',
          ),
        },
        signed(trip.pnl),
      ),
    );
  };
  const notes = [
    preview.open.length
      ? `Still open, not added: ${preview.open.map((item) => `${item.symbol} (${item.quantity > 0 ? '+' : ''}${item.quantity})`).join(', ')}. Add them once the position is closed.`
      : null,
    ...preview.skipped.map((item) => `Not added — ${item.symbol}: ${item.reason}`),
  ].filter(Boolean);
  addButton.addEventListener('click', async () => {
    if (!chosen.size) return;
    addButton.disabled = true;
    addButton.textContent = 'Adding…';
    try {
      const result = await api(`${source.path}/import`, {
        method: 'POST',
        body: { ids: [...chosen] },
        timeout: 60_000,
      });
      onAdded(result.added);
      notify(
        `Added ${result.added.length} ${result.added.length === 1 ? 'trade' : 'trades'} from ${source.label}${result.skipped ? ` (${result.skipped} already present)` : ''}.`,
        'success',
      );
      close();
    } catch (error) {
      notify(errorMessage(error, 'Could not add the fills.'), 'error');
      paintButton();
    }
  });
  paintButton();
  body.replaceChildren(
    h('p', { class: 'text-xs text-muted' }, `Fills for ${preview.tradingDate} (IST).`),
    preview.candidates.length
      ? h(
          'div',
          { class: 'max-h-[50vh] overflow-auto' },
          h(
            'table',
            { class: 'stack-table w-full min-w-[560px] tnum text-sm' },
            h(
              'thead',
              {
                class: 'border-b border-line text-left text-xs uppercase tracking-wide text-muted',
              },
              h(
                'tr',
                {},
                h('th', { class: 'py-2' }),
                h('th', { class: 'py-2 pr-3' }, 'Round trip'),
                h('th', { class: 'py-2 pr-3 text-right' }, 'Qty'),
                h('th', { class: 'py-2 pr-3 text-right' }, 'Entry → exit'),
                h('th', { class: 'py-2 pr-3 text-right' }, 'Charges'),
                h('th', { class: 'py-2 text-right' }, 'Net P&L'),
              ),
            ),
            h('tbody', {}, preview.candidates.map(row)),
          ),
        )
      : h('p', { class: 'text-sm text-muted' }, 'No completed round trips in today’s fills yet.'),
    ...notes.map((text) => h('p', { class: 'text-xs text-muted' }, text)),
    h(
      'div',
      { class: 'flex gap-2' },
      button(t('Cancel'), { variant: 'outline', className: 'flex-1', onclick: close }),
      preview.candidates.length ? addButton : null,
    ),
  );
}
