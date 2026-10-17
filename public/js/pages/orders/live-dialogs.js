/**
 * Order review dialogs that reach Zerodha: placing a reviewed plan as a live
 * LIMIT order, and the stop-loss/target GTT for a filled delivery buy. Each
 * asks the member to type the symbol; `onDone` reloads the live order state.
 */
import { t } from '../../core/i18n.js';
import { h, button, input, label, formatCurrency } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { openModal } from '../../core/dialog.js';
import { notify } from '../../core/toast.js';
import { formatPlanningPrice } from '../../../../shared/risk-calculator.js';

/**
 * Opens the live Zerodha order dialog for a plan. The user must retype the symbol and tick
 * the acknowledgement before it POSTs to /api/live-orders; then calls `onDone`.
 */
export function openLiveOrder(plan, { onDone }) {
  const side = plan.direction === 'Short' ? 'SELL' : 'BUY';
  const quantity = plan.estimate.quantity;
  const value = quantity * Number(plan.inputs.entryPrice);
  const idempotencyKey = crypto.randomUUID();
  openModal({
    title: t('Place live order with Zerodha'),
    description: t('This sends a real order to your broker account.'),
    content: (close) => {
      const confirmField = input({
        id: 'live-confirm-symbol',
        autocomplete: 'off',
        placeholder: plan.symbol,
      });
      const acknowledge = h('input', { type: 'checkbox', class: 'mt-1' });
      const submit = button(t('Place order'), { variant: 'destructive', disabled: true });
      const message = h('p', { role: 'alert', class: 'text-sm text-negative', hidden: true });
      const sync = () => {
        submit.disabled =
          !acknowledge.checked || confirmField.value.trim().toUpperCase() !== plan.symbol;
      };
      confirmField.addEventListener('input', sync);
      acknowledge.addEventListener('change', sync);
      submit.addEventListener('click', async () => {
        submit.disabled = true;
        submit.textContent = 'Placing…';
        message.hidden = true;
        try {
          const { order } = await api('/api/live-orders', {
            method: 'POST',
            body: { planId: plan.id, confirmSymbol: confirmField.value, idempotencyKey },
            timeout: 45_000,
          });
          close();
          if (order.status === 'placed')
            notify(`Order placed with Zerodha (order ${order.brokerOrderId}).`, 'success');
          else notify(order.error || 'The order was not placed.', 'error');
          await onDone();
        } catch (error) {
          message.textContent = errorMessage(error, 'The order could not be placed.');
          message.hidden = false;
          submit.textContent = 'Place order';
          sync();
        }
      });
      const row = (term, text) =>
        h(
          'div',
          { class: 'flex justify-between gap-3 border-b border-line py-2 text-sm' },
          h('dt', { class: 'text-muted' }, term),
          h('dd', { class: 'tnum text-right' }, text),
        );
      return h(
        'div',
        { class: 'space-y-4' },
        h(
          'dl',
          {},
          row('Instrument', `NSE · ${plan.symbol}`),
          row('Side', side),
          row('Product', plan.product),
          row('Order type', 'LIMIT · DAY'),
          row('Quantity', quantity.toLocaleString('en-IN')),
          row('Limit price', formatPlanningPrice(plan.inputs.entryPrice)),
          row('Order value', formatCurrency(value)),
        ),
        h(
          'p',
          { class: 'text-xs leading-5 text-muted' },
          'Only the entry order is sent. Your planned stop and target are NOT placed automatically — set them in Zerodha yourself. Prices can move before the order reaches the exchange; Zerodha may reject the order for margin, price band or other reasons.',
        ),
        h(
          'div',
          { class: 'space-y-2' },
          h(
            'label',
            { for: 'live-confirm-symbol', class: 'mb-1.5 block text-xs font-medium text-muted' },
            `Type ${plan.symbol} to confirm`,
          ),
          confirmField,
        ),
        h(
          'label',
          { class: 'flex items-start gap-2 text-sm' },
          acknowledge,
          h('span', {}, 'I understand this places a real order with my own money.'),
        ),
        message,
        h(
          'div',
          { class: 'flex flex-wrap justify-end gap-2' },
          button(t('Cancel'), { variant: 'outline', onclick: close }),
          submit,
        ),
      );
    },
  });
}

/**
 * Opens the dialog that places a stop/target GTT for a filled order. The user must retype
 * the symbol before it POSTs to /api/live-orders/:id/gtt; then calls `onDone`.
 */
export function openGtt(plan, order, { onDone }) {
  openModal({
    title: t('Place stop & target on Zerodha'),
    description: t(
      'A GTT that sells the filled quantity at your stop or your target; when one triggers, Zerodha cancels the other.',
    ),
    content: (close) => {
      const confirmField = input({
        id: 'gtt-confirm-symbol',
        autocomplete: 'off',
        placeholder: order.symbol,
      });
      const submit = button(t('Place GTT'), { variant: 'destructive', disabled: true });
      const message = h('p', { role: 'alert', class: 'text-sm text-negative', hidden: true });
      confirmField.addEventListener('input', () => {
        submit.disabled = confirmField.value.trim().toUpperCase() !== order.symbol;
      });
      submit.addEventListener('click', async () => {
        submit.disabled = true;
        submit.textContent = 'Placing…';
        message.hidden = true;
        try {
          const result = await api(`/api/live-orders/${encodeURIComponent(order.id)}/gtt`, {
            method: 'POST',
            body: { confirmSymbol: confirmField.value },
            timeout: 45_000,
          });
          close();
          if (result.order.gtt?.status === 'placed')
            notify(`GTT placed with Zerodha (${result.order.gtt.triggerId}).`, 'success');
          else notify(result.order.gtt?.error || 'The GTT was not placed.', 'error');
          await onDone();
        } catch (error) {
          message.textContent = errorMessage(error, 'The GTT could not be placed.');
          message.hidden = false;
          submit.textContent = 'Place GTT';
          submit.disabled = false;
        }
      });
      const row = (term, text) =>
        h(
          'div',
          { class: 'flex justify-between gap-3 border-b border-line py-2 text-sm' },
          h('dt', { class: 'text-muted' }, term),
          h('dd', { class: 'tnum text-right' }, text),
        );
      return h(
        'div',
        { class: 'space-y-4' },
        h(
          'dl',
          {},
          row('Instrument', `NSE · ${order.symbol} · CNC`),
          row('Sell quantity', order.quantity.toLocaleString('en-IN')),
          row('Stop-loss trigger', formatPlanningPrice(plan.inputs.stopLoss)),
          row(
            'Target trigger',
            plan.inputs.takeProfit
              ? formatPlanningPrice(plan.inputs.takeProfit)
              : 'None (stop only)',
          ),
        ),
        h(
          'p',
          { class: 'text-xs leading-5 text-muted' },
          'The stop leg is a LIMIT order 0.5% below its trigger to help it fill; in a fast fall it may still not fill. The entry must be completely filled first. GTTs stay active until triggered, cancelled in Kite or expired (one year).',
        ),
        h(
          'div',
          { class: 'space-y-2' },
          label(`Type ${order.symbol} to confirm`, confirmField.id),
          confirmField,
        ),
        message,
        h(
          'div',
          { class: 'flex gap-2' },
          button(t('Cancel'), { variant: 'outline', onclick: close }),
          submit,
        ),
      );
    },
  });
}
