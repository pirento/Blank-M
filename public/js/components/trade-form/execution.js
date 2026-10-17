/**
 * "Execution (optional)" part of the trade form: stop-loss, entry and exit
 * times, orders per side and partial exits. With two or more partial exits
 * the exit price is their weighted average and is filled in for the member.
 */
import { h, input, label, button, fieldError } from '../../core/dom.js';
import { MAX_EXIT_LEGS, parseTradeExecution } from '../../../../shared/trade-execution.js';

const text = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * @param {{ trade?: object, id: (name: string) => string, onChange: () => void }} options
 */
export function createExecutionSection({ trade, id, onChange }) {
  const fields = {
    stopLoss: input({
      id: id('stop'),
      type: 'number',
      step: 'any',
      min: '0',
      placeholder: 'e.g. 97.50',
      value: text(trade?.stopLoss),
    }),
    entryTime: input({ id: id('entry-time'), type: 'time', value: text(trade?.entryTime) }),
    exitTime: input({ id: id('exit-time'), type: 'time', value: text(trade?.exitTime) }),
    entryOrders: input({
      id: id('entry-orders'),
      type: 'number',
      step: '1',
      min: '1',
      placeholder: '1',
      value: text(trade?.entryOrders),
    }),
  };
  let legs = (trade?.exitLegs ?? []).map((leg) => ({
    price: text(leg.price),
    quantity: text(leg.quantity),
  }));
  let errors = {};
  const slots = {};
  const legsBox = h('div', { class: 'space-y-2' });
  const legsError = h('div');

  const field = (key, labelText) => {
    slots[key] = h('div');
    return h(
      'div',
      { class: 'space-y-2' },
      label(labelText, fields[key].id),
      fields[key],
      slots[key],
    );
  };

  function paintLegs() {
    legsBox.replaceChildren(
      ...legs.map((leg, index) => {
        const priceInput = input({
          id: id(`leg-price-${index}`),
          type: 'number',
          step: 'any',
          min: '0',
          placeholder: 'Price',
          value: leg.price,
          'aria-label': `Partial exit ${index + 1} price`,
          oninput: (event) => {
            legs[index].price = event.target.value;
          },
        });
        const quantityInput = input({
          id: id(`leg-qty-${index}`),
          type: 'number',
          step: '1',
          min: '1',
          placeholder: 'Quantity',
          value: leg.quantity,
          'aria-label': `Partial exit ${index + 1} quantity`,
          oninput: (event) => {
            legs[index].quantity = event.target.value;
          },
        });
        return h(
          'div',
          { class: 'flex items-center gap-2' },
          priceInput,
          quantityInput,
          button('Remove', {
            variant: 'ghost',
            size: 'sm',
            'aria-label': `Remove partial exit ${index + 1}`,
            onclick: () => {
              legs = legs.filter((_, position) => position !== index);
              paintLegs();
              onChange();
            },
          }),
        );
      }),
      legs.length < MAX_EXIT_LEGS
        ? button(legs.length ? 'Add another exit' : 'Split the exit into parts', {
            variant: 'outline',
            size: 'sm',
            onclick: () => {
              // Two rows to start: a split needs at least two parts.
              legs = legs.length
                ? [...legs, { price: '', quantity: '' }]
                : [
                    { price: '', quantity: '' },
                    { price: '', quantity: '' },
                  ];
              paintLegs();
              onChange();
            },
          })
        : null,
    );
  }

  const element = h(
    'details',
    {
      class: 'rounded-control border border-line p-3',
      open: Boolean(
        trade?.stopLoss || trade?.entryTime || trade?.exitLegs?.length || trade?.entryOrders,
      ),
    },
    h('summary', { class: 'cursor-pointer text-sm text-fg' }, 'Execution (optional)'),
    h(
      'div',
      { class: 'mt-3 space-y-4' },
      h(
        'div',
        { class: 'grid grid-cols-1 gap-4 sm:grid-cols-2' },
        field('stopLoss', 'Stop-loss price'),
        field('entryOrders', 'Entry orders'),
        field('entryTime', 'Entry time (IST)'),
        field('exitTime', 'Exit time (IST)'),
      ),
      h(
        'fieldset',
        { class: 'space-y-2' },
        h('legend', { class: 'text-sm text-fg' }, 'Partial exits'),
        h(
          'p',
          { class: 'text-xs text-muted' },
          'Sold in parts? Add each part; the exit price becomes their average and each part counts as an order for brokerage.',
        ),
        legsBox,
        legsError,
      ),
    ),
  );
  paintLegs();

  return {
    element,
    /** Raw values for parseTradeExecution and the request body. */
    read() {
      return {
        stopLoss: fields.stopLoss.value,
        entryTime: fields.entryTime.value,
        exitTime: fields.exitTime.value,
        entryOrders: fields.entryOrders.value,
        // Not editable here; keep a broker import's count unless partial exits decide it.
        exitOrders: legs.length ? null : (trade?.exitOrders ?? null),
        exitLegs: legs,
      };
    },
    parse(trade) {
      return parseTradeExecution(this.read(), trade);
    },
    showErrors(next) {
      errors = next;
      for (const [key, slot] of Object.entries(slots)) {
        const message = errors[key];
        fields[key].classList.toggle('border-negative', Boolean(message));
        if (message) fields[key].setAttribute('aria-invalid', 'true');
        else fields[key].removeAttribute('aria-invalid');
        slot.replaceChildren(...[fieldError(`${fields[key].id}-error`, message)].filter(Boolean));
      }
      legsError.replaceChildren(...[fieldError(id('legs-error'), errors.exitLegs)].filter(Boolean));
      legsBox.classList.toggle('text-negative', Boolean(errors.exitLegs));
    },
    hasLegs: () => legs.filter((leg) => leg.price !== '' || leg.quantity !== '').length > 1,
  };
}
