/**
 * Settings page — risk limits: daily loss limit, trades per day and a monthly
 * goal. Reaching the daily loss or trade limit stops live orders for the day.
 */
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
  render,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { available, cardDescription, settings, statusLine } from './shared.js';

const FIELDS = [
  { key: 'dailyLossLimit', id: 'risk-daily-loss', label: 'Daily loss limit (₹)', mode: 'decimal' },
  { key: 'maxTradesPerDay', id: 'risk-max-trades', label: 'Trades per day', mode: 'numeric' },
  {
    key: 'monthlyProfitGoal',
    id: 'risk-month-goal',
    label: 'Monthly profit goal (₹)',
    mode: 'decimal',
  },
];

/** Mounts the risk limits form; blank fields mean off, and Save sends them via PUT /api/settings. */
export function mountRiskLimits() {
  const root = $('[data-risk-limits]');
  if (!root) return;
  const current = settings.riskLimits ?? {};
  const state = { busy: false, message: '' };
  const inputs = Object.fromEntries(
    FIELDS.map((field) => [
      field.key,
      input({
        id: field.id,
        inputmode: field.mode,
        placeholder: t('Off'),
        value:
          current[field.key] === null || current[field.key] === undefined
            ? ''
            : String(current[field.key]),
        disabled: !available,
      }),
    ]),
  );
  const saveButton = button(t('Save risk limits'), {
    disabled: !available,
    onclick: async () => {
      if (state.busy) return;
      Object.assign(state, { busy: true, message: '' });
      paint();
      try {
        const body = Object.fromEntries(
          FIELDS.map((field) => [field.key, inputs[field.key].value.trim()]),
        );
        await api('/api/settings', { method: 'PUT', body: { riskLimits: body } });
        state.message = 'Risk limits saved.';
      } catch (error) {
        state.message = errorMessage(error, 'Could not save risk limits.');
      } finally {
        state.busy = false;
        paint();
      }
    },
  });
  const messageSlot = h('div');
  const paint = () => {
    saveButton.disabled = state.busy || !available;
    saveButton.textContent = state.busy ? 'Saving…' : 'Save risk limits';
    render(messageSlot, state.message ? statusLine(state.message) : null);
  };
  render(
    root,
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Risk limits')),
          cardDescription(
            t(
              'Leave a field empty to turn it off. When today’s net loss or number of trades reaches its limit, live orders stop until the next trading day and the dashboard shows it.',
            ),
          ),
        ),
      ),
      cardContent(
        'space-y-4',
        h(
          'div',
          { class: 'grid grid-cols-1 gap-4 sm:grid-cols-3' },
          FIELDS.map((field) =>
            h('div', { class: 'space-y-2' }, label(field.label, field.id), inputs[field.key]),
          ),
        ),
        h('div', { class: 'flex flex-wrap items-center gap-3' }, saveButton, messageSlot),
      ),
    ),
  );
}
