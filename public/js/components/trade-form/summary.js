/**
 * Read-only parts of the trade form: the live P&L preview and the summary
 * shown in the confirmation dialog.
 */
import { h, formatCurrency } from '../../core/dom.js';

function row(labelText, value) {
  return h(
    'div',
    { class: 'flex justify-between border-b border-line pb-2 last:border-0' },
    h('span', { class: 'text-muted' }, labelText),
    h('span', { class: 'font-bold' }, value),
  );
}

/** Gross, charges and net for the values typed so far. */
export function previewPanel(result, { editing, changed }) {
  return h(
    'div',
    { class: 'border border-line bg-elevated p-4 tnum text-xs' },
    editing
      ? h(
          'p',
          { class: 'mb-2 text-muted' },
          changed
            ? 'Economic inputs changed: charges and P&L will be recalculated using current settings.'
            : 'Historical charges and P&L are preserved for metadata-only edits.',
        )
      : null,
    h(
      'div',
      { class: 'flex justify-between' },
      h('span', { class: 'text-muted' }, 'Gross P&L'),
      h('span', {}, formatCurrency(result.grossPnl)),
    ),
    h(
      'div',
      { class: 'flex justify-between' },
      h('span', { class: 'text-muted' }, 'Charges'),
      h('span', {}, `-${formatCurrency(result.charges)}`),
    ),
    h(
      'div',
      { class: 'mt-2 flex justify-between border-t border-line pt-2 font-bold' },
      h('span', {}, 'Net P&L'),
      h(
        'span',
        { class: result.netPnl >= 0 ? 'text-positive' : 'text-negative' },
        formatCurrency(result.netPnl),
      ),
    ),
  );
}

/** Rows of the confirmation dialog. */
export function confirmRows(form, result, risk) {
  return [
    row('Symbol', form.symbol.toUpperCase()),
    form.segment === 'EQ'
      ? null
      : row(
          'Contract',
          [
            form.segment === 'FUT' ? 'Future' : `${form.optionType} ${form.strike || ''}`.trim(),
            form.expiry && `exp ${form.expiry}`,
            form.lotSize && `lot ${form.lotSize}`,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
    row('Direction', form.type),
    row('Quantity', form.quantity),
    row('Entry', `₹${form.entryPrice}`),
    row('Exit', `₹${form.exitPrice}`),
    risk ? row('Planned risk', formatCurrency(risk)) : null,
    result ? row('Charges', formatCurrency(result.charges)) : null,
    result ? row('Net P&L', formatCurrency(result.netPnl)) : null,
  ].filter(Boolean);
}
