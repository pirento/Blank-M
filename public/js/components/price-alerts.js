/**
 * Price alerts panel (Watchlist page): create alerts above or below a price,
 * see active and fired alerts, re-arm or delete them. While the page is open,
 * active alerts are checked every minute; a fired alert shows a toast (and a
 * system notification when push is on). The scheduled price check covers the
 * rest of the day.
 */
import { t } from '../core/i18n.js';
import {
  h,
  cn,
  button,
  input,
  label,
  select,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatIstDateTime,
  render,
  errorLine,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { notify, notifyError } from '../core/toast.js';

const CHECK_EVERY_MS = 60_000;

/** @param {{ watchlist: { symbol: string }[] }} options */
export function createPriceAlerts({ watchlist }) {
  const state = { alerts: [], channels: { push: false, email: false }, error: '', saving: false };
  const root = h('div');

  const fields = {
    symbol: input({
      id: 'alert-symbol',
      placeholder: 'INFY',
      autocomplete: 'off',
      list: 'alert-symbols',
    }),
    condition: select({ id: 'alert-condition' }, [
      { value: 'above', label: 'Rises to or above', selected: true },
      { value: 'below', label: 'Falls to or below' },
    ]),
    price: input({ id: 'alert-price', type: 'number', min: '0', step: 'any', placeholder: '1500' }),
    note: input({ id: 'alert-note', maxlength: '200', placeholder: t('Optional note') }),
    email: h('input', { type: 'checkbox', id: 'alert-email', class: 'h-4 w-4 accent-accent' }),
  };
  const symbols = h(
    'datalist',
    { id: 'alert-symbols' },
    watchlist.map((item) => h('option', { value: item.symbol })),
  );
  const formError = h('div');
  const save = button(t('Add alert'), { type: 'submit' });
  const form = h(
    'form',
    { class: 'grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end', novalidate: true },
    h('div', { class: 'space-y-1' }, label(t('Symbol'), fields.symbol.id), fields.symbol, symbols),
    h(
      'div',
      { class: 'space-y-1' },
      label(t('When the price'), fields.condition.id),
      fields.condition,
    ),
    h('div', { class: 'space-y-1' }, label(t('Price (₹)'), fields.price.id), fields.price),
    save,
    h('div', { class: 'space-y-1 sm:col-span-3' }, label(t('Note'), fields.note.id), fields.note),
    h(
      'label',
      { class: 'flex items-center gap-2 text-sm', for: fields.email.id },
      fields.email,
      'Also email me',
    ),
    h('div', { class: 'sm:col-span-4' }, formError),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.saving) return;
    state.saving = true;
    render(formError);
    save.disabled = true;
    try {
      await api('/api/alerts', {
        method: 'POST',
        body: {
          symbol: fields.symbol.value,
          condition: fields.condition.value,
          price: fields.price.value,
          note: fields.note.value,
          channels: { push: true, email: fields.email.checked },
        },
      });
      notify(`Alert added for ${fields.symbol.value.trim().toUpperCase()}.`, 'success');
      fields.price.value = '';
      fields.note.value = '';
      await load();
    } catch (error) {
      render(formError, errorLine(errorMessage(error, 'Could not add the alert.')));
    } finally {
      state.saving = false;
      save.disabled = false;
    }
  });

  async function act(path, method, success) {
    try {
      await api(path, { method });
      notify(success, 'success');
      await load();
    } catch (error) {
      notifyError(error, 'The alert could not be updated.');
    }
  }

  const describe = (alert) =>
    `${alert.condition === 'above' ? '≥' : '≤'} ₹${alert.price.toLocaleString('en-IN')}`;

  function alertRow(alert) {
    const fired = alert.status === 'triggered';
    return h(
      'li',
      {
        class:
          'flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0',
      },
      h(
        'div',
        { class: 'min-w-0 text-sm' },
        h('span', { class: 'font-medium text-fg' }, alert.symbol),
        h('span', { class: cn('ml-2 tnum', fired ? 'text-muted' : 'text-fg') }, describe(alert)),
        alert.note ? h('span', { class: 'ml-2 text-xs text-muted' }, alert.note) : null,
        h(
          'div',
          { class: 'text-xs text-muted' },
          fired
            ? `Fired at ₹${alert.triggeredPrice} · ${formatIstDateTime(alert.triggeredAt)} IST`
            : `Active${alert.channels.email ? ' · email on' : ''}`,
        ),
      ),
      h(
        'div',
        { class: 'flex gap-1' },
        fired
          ? button(t('Re-arm'), {
              variant: 'outline',
              size: 'sm',
              onclick: () =>
                void act(
                  `/api/alerts/${encodeURIComponent(alert.id)}/reactivate`,
                  'POST',
                  'Alert re-armed.',
                ),
            })
          : null,
        button(t('Delete'), {
          variant: 'ghost',
          size: 'sm',
          className: 'text-negative',
          'aria-label': `Delete the ${alert.symbol} alert at ₹${alert.price}`,
          onclick: () =>
            void act(`/api/alerts/${encodeURIComponent(alert.id)}`, 'DELETE', 'Alert deleted.'),
        }),
      ),
    );
  }

  function paint() {
    fields.email.disabled = !state.channels.email;
    const active = state.alerts.filter((alert) => alert.status === 'active');
    const fired = state.alerts.filter((alert) => alert.status === 'triggered');
    render(
      root,
      card(
        { 'aria-label': t('Price alerts') },
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Price alerts')),
            h(
              'p',
              { class: 'mt-1 text-sm text-muted' },
              state.channels.push
                ? 'Alerts are checked every few minutes in market hours and notify every device where notifications are on (Settings → Notifications).'
                : 'Alerts are checked while this page is open and by the scheduled price check.',
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          form,
          state.error ? errorLine(state.error) : null,
          active.length
            ? h('ul', {}, active.map(alertRow))
            : h('p', { class: 'text-sm text-muted' }, 'No active alerts.'),
          fired.length
            ? h(
                'details',
                {},
                h(
                  'summary',
                  { class: 'cursor-pointer text-sm text-muted' },
                  `Fired (${fired.length})`,
                ),
                h('ul', { class: 'mt-2' }, fired.map(alertRow)),
              )
            : null,
        ),
      ),
    );
  }

  async function load() {
    try {
      const result = await api('/api/alerts');
      state.alerts = result.alerts;
      state.channels = result.channels;
      state.error = '';
    } catch (error) {
      state.error = errorMessage(error, 'Alerts could not be loaded.');
    }
    paint();
  }

  async function check() {
    if (document.hidden || !state.alerts.some((alert) => alert.status === 'active')) return;
    try {
      const result = await api('/api/alerts/check', { method: 'POST', timeout: 60_000 });
      state.alerts = result.alerts;
      for (const alert of result.fired) {
        notify(
          `${alert.symbol} reached ₹${alert.triggeredPrice} (alert ${describe(alert)}).`,
          'success',
        );
      }
      paint();
    } catch {
      // A failed check is retried on the next interval.
    }
  }

  /** Prefill the form for one instrument (used by the per-row Alert buttons). */
  function prefill(symbol) {
    fields.symbol.value = symbol;
    fields.price.focus();
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  paint();
  void load().then(check);
  setInterval(() => void check(), CHECK_EVERY_MS);
  return { element: root, prefill };
}
