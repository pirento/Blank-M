/** Settings page — charge rates for equity, futures and options. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  icon,
  button,
  input,
  label,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatCurrency,
  render,
} from '../../core/dom.js';
import { api } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import { computeCharges } from '../../../../shared/pnl.js';
import { DEFAULT_CHARGES } from '../../../../shared/types.js';
import { DEFAULT_FO_CHARGES } from '../../../../shared/segments.js';
import { available, cardDescription, plainFact, settings } from './shared.js';

const CHARGE_FIELDS = [
  { key: 'brokeragePercent', label: 'Brokerage %', hint: t('Per order value') },
  { key: 'brokerageMaxPerOrder', label: 'Brokerage cap (₹)', hint: t('Maximum per order') },
  { key: 'sttPercent', label: 'STT %', hint: t('Intraday sell side') },
  { key: 'exchangeTxnPercent', label: 'Exchange txn %', hint: t('Total turnover') },
  { key: 'sebiPercent', label: 'SEBI %', hint: t('Total turnover') },
  { key: 'gstPercent', label: 'GST %', hint: t('Brokerage + exchange + SEBI') },
  { key: 'stampDutyPercent', label: 'Stamp duty %', hint: t('Buy side') },
];

/**
 * One editable set of charge rates. `read`/`write` pick the rates out of the
 * settings response and build the request body; `idPrefix` keeps control IDs
 * unique when several cards share the page.
 */
function mountRateCard(
  root,
  {
    title,
    description,
    initial,
    defaults,
    idPrefix,
    sample,
    read,
    write,
    toggleLabel,
    saveLabel = 'Save charges',
    hints = {},
  },
) {
  let charges = { ...initial };
  let saving = false;
  const enabled = h('input', { type: 'checkbox', class: 'h-4 w-4 accent-accent' });
  const controls = {};
  const fields = CHARGE_FIELDS.map((field) => {
    const control = input({
      id: `${idPrefix}-${field.key}`,
      type: 'number',
      step: '0.00001',
      min: '0',
    });
    control.addEventListener('input', () => {
      charges = { ...charges, [field.key]: Number(control.value) || 0 };
      paintSample();
    });
    controls[field.key] = control;
    return h(
      'div',
      { class: 'space-y-1' },
      label(field.label, control.id),
      control,
      h('p', { class: 'text-xs text-subtle' }, hints[field.key] ?? field.hint),
    );
  });
  const sampleBox = h('div', {
    class: 'grid gap-3 rounded-card border border-line bg-elevated p-4 sm:grid-cols-3',
  });
  const saveButton = button('');
  const paintSample = () => {
    const total = computeCharges(sample.trade, charges).total;
    render(
      sampleBox,
      plainFact('Sample turnover', sample.turnover),
      plainFact('Estimated charges', formatCurrency(total)),
      plainFact(
        `Net on ${formatCurrency(sample.gross)} gross`,
        formatCurrency(sample.gross - total),
      ),
    );
  };
  /** Write the current charges into the controls without rebuilding them. */
  const sync = () => {
    enabled.checked = charges.enabled;
    for (const field of CHARGE_FIELDS) {
      controls[field.key].value = String(charges[field.key]);
      controls[field.key].disabled = !charges.enabled;
    }
    render(saveButton, icon('save', 14, 'mr-2'), saving ? 'Saving…' : saveLabel);
    saveButton.disabled = saving || !available;
    paintSample();
  };
  enabled.addEventListener('change', () => {
    charges = { ...charges, enabled: enabled.checked };
    sync();
  });
  saveButton.addEventListener('click', async () => {
    if (saving) return;
    saving = true;
    sync();
    try {
      const result = await api('/api/settings', { method: 'PUT', body: write(charges) });
      charges = { ...read(result.settings) };
      notify('Charge rates saved.', 'success');
    } catch (error) {
      notifyError(error, 'Could not save charge rates.');
    } finally {
      saving = false;
      sync();
    }
  });
  render(
    root,
    card(
      {},
      cardHeader('', h('div', {}, cardTitle(title), cardDescription(description))),
      cardContent(
        'space-y-6',
        h('label', { class: 'flex items-center gap-3 text-sm' }, enabled, toggleLabel),
        h('div', { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4' }, fields),
        sampleBox,
        h(
          'div',
          { class: 'flex flex-wrap gap-2' },
          saveButton,
          button([icon('rotate-ccw', 14, 'mr-2'), 'Reset defaults'], {
            variant: 'outline',
            onclick: () => {
              charges = { ...defaults };
              sync();
            },
          }),
        ),
      ),
    ),
  );
  sync();
}

/** Mounts the equity, futures and options charge rate cards, each saved via PUT /api/settings. */
export function mountCharges() {
  mountRateCard($('[data-charges]'), {
    title: t('Brokerage & statutory charges'),
    description: t('Convert gross price movement into the P&L that reaches your account.'),
    toggleLabel: 'Apply brokerage and statutory charges',
    initial: settings.charges,
    defaults: DEFAULT_CHARGES,
    idPrefix: 'charge',
    sample: {
      trade: { type: 'Long', entryPrice: 1000, exitPrice: 1010, quantity: 100 },
      turnover: '₹2,01,000',
      gross: 1000,
    },
    read: (saved) => saved.charges,
    write: (charges) => ({ charges }),
  });
  const fo = settings.foCharges ?? DEFAULT_FO_CHARGES;
  mountRateCard($('[data-fo-charges-futures]'), {
    title: t('Futures charges'),
    description: t('Used for trades logged with the Futures segment.'),
    toggleLabel: 'Apply charges to futures trades',
    initial: fo.futures,
    defaults: DEFAULT_FO_CHARGES.futures,
    idPrefix: 'fut-charge',
    saveLabel: 'Save futures charges',
    sample: {
      trade: { type: 'Long', entryPrice: 24500, exitPrice: 24520, quantity: 75 },
      turnover: '₹36,76,500',
      gross: 1500,
    },
    read: (saved) => saved.foCharges.futures,
    write: (futures) => ({ foCharges: { futures } }),
    hints: { sttPercent: 'Sell side' },
  });
  mountRateCard($('[data-fo-charges-options]'), {
    title: t('Options charges'),
    description: t('Used for trades logged with the Options segment. Prices are premiums.'),
    toggleLabel: 'Apply charges to options trades',
    initial: fo.options,
    defaults: DEFAULT_FO_CHARGES.options,
    idPrefix: 'opt-charge',
    saveLabel: 'Save options charges',
    sample: {
      trade: { type: 'Long', entryPrice: 100, exitPrice: 120, quantity: 75 },
      turnover: '₹16,500',
      gross: 1500,
    },
    read: (saved) => saved.foCharges.options,
    write: (options) => ({ foCharges: { options } }),
    hints: {
      brokeragePercent: '100% with a ₹20 cap = ₹20 flat per order',
      sttPercent: 'Sell-side premium',
      exchangeTxnPercent: 'Premium turnover',
    },
  });
}
