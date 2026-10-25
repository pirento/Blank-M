/**
 * Static calculator layout: symbol control, position card and estimate card.
 */
import { h, icon, button, input, label as fieldLabel } from '../../core/dom.js';
import { syncBalance } from './broker-sync.js';
import { numberField, selectField, update } from './fields.js';
import { paintEstimate } from './painting.js';
import { loadQuote, setSymbol } from './quotes.js';
import { accountId, fields, state, strategies, watchlist } from './shared.js';

export const quoteNote = h('p', { class: 'text-xs leading-5 text-muted' });
export const refreshQuote = button([icon('refresh-cw', 13, 'mr-2'), ' Refresh quote'], {
  variant: 'outline',
  size: 'sm',
  className: 'mt-2',
  onclick: () => void loadQuote(),
});
export const syncButton = button('Sync broker balance', {
  variant: 'outline',
  disabled: !accountId,
  onclick: () => void syncBalance(),
});
export const syncNote = h('p', { role: 'status', class: 'text-sm text-muted', hidden: true });
export const estimate = h('div', { class: 'space-y-4' });

function symbolControl() {
  if (watchlist.length) {
    const options = [['', 'Choose an instrument']];
    if (state.symbol && !watchlist.some((item) => item.symbol === state.symbol))
      options.push([state.symbol, state.symbol]);
    for (const item of watchlist) options.push([item.symbol, item.symbol]);
    return selectField('calc-symbol', 'Watchlist instrument', options, state.symbol, setSymbol)
      .element;
  }
  const control = input({
    id: 'calc-symbol',
    value: state.symbol,
    maxlength: '20',
    placeholder: 'e.g. RELIANCE',
  });
  control.addEventListener('input', () => {
    control.value = control.value.toUpperCase();
    setSymbol(control.value);
  });
  return h(
    'div',
    { class: 'space-y-2' },
    fieldLabel('Watchlist instrument', 'calc-symbol'),
    control,
  );
}

export const reward = selectField(
  'calc-reward-preset',
  'Risk : reward',
  [
    ['2', '1 : 2'],
    ['3', '1 : 3'],
    ['4', '1 : 4'],
    ['custom', 'Custom'],
  ],
  state.rewardPreset,
  (value) => {
    state.rewardPreset = value;
    update('rewardMultiple', value === 'custom' ? state.customReward : value);
  },
);
export const rewardPresetError = h('p', {
  role: 'alert',
  class: 'mt-1 text-xs text-negative',
  hidden: true,
});

const positionCard = h(
  'div',
  {
    class:
      'min-w-0 rounded-card border border-line bg-surface p-4 min-[761px]:p-5 min-[1001px]:p-[26px]',
  },
  h(
    'div',
    { class: 'mb-[23px] flex items-start justify-between gap-4' },
    h('h3', { class: 'text-base font-normal text-fg' }, 'Position details'),
    h(
      'span',
      {
        class:
          'shrink-0 rounded-sm border border-line px-2 py-1 font-mono text-[10px] tracking-wider text-muted',
      },
      'MANUAL PLAN',
    ),
  ),
  h(
    'div',
    { class: 'space-y-5' },
    !watchlist.length
      ? h(
          'p',
          { class: 'text-sm text-muted' },
          'Choose an instrument from your ',
          h('a', { class: 'text-accent underline', href: '/watchlist' }, 'watchlist'),
          ', or enter its NSE symbol below.',
        )
      : null,
    h(
      'div',
      {
        'aria-label': 'Position details',
        class:
          'grid grid-cols-2 gap-x-[15px] gap-y-[22px] min-[761px]:grid-cols-1 min-[1001px]:grid-cols-2 min-[1001px]:gap-x-[26px]',
      },
      symbolControl(),
      selectField(
        'calc-direction',
        'Direction',
        [
          ['Long', 'Buy / long'],
          ['Short', 'Sell / short'],
        ],
        fields.direction,
        (value) => update('direction', value),
      ).element,
      numberField('accountSize', 'Planning capital (₹)'),
      numberField('entryPrice', 'Entry price (₹)'),
      selectField(
        'calc-product',
        'Product',
        [
          ['MIS', 'MIS · intraday'],
          ['CNC', 'CNC · delivery'],
        ],
        fields.product,
        (value) => update('product', value),
      ).element,
      numberField('marginPercent', 'Illustrative margin (%)'),
      numberField('riskPercent', 'Account risk per trade (%)'),
      numberField('stopDistancePercent', 'Stop distance from entry (%)'),
      numberField('stopLoss', 'Stop loss'),
      h(
        'div',
        { class: 'min-w-0 space-y-2', dataset: { mode: 'percent' } },
        ...reward.element.childNodes,
      ),
      numberField('rewardMultiple', 'Custom reward multiple'),
      h('div', { dataset: { mode: 'percent' } }, rewardPresetError),
      numberField('takeProfit', 'Take profit (optional)'),
      numberField(
        'estimatedRoundTripCharges',
        'Estimated round-trip charges (₹)',
        'Leave blank to use the rates in Settings. Delivery (CNC) needs your own estimate.',
      ),
      numberField('quantity', 'Quantity override (blank = automatic)'),
    ),
    h(
      'p',
      { class: 'text-[13px] leading-relaxed text-muted' },
      'MIS changes margin requirements, not the share price. The live platform must obtain required margin from the broker. CNC uses 100% of notional value.',
    ),
    syncButton,
    syncNote,
    h(
      'details',
      { class: 'border-t border-line pt-4' },
      h(
        'summary',
        { class: 'focus-ring cursor-pointer text-[13px] text-muted' },
        'Additional planning options',
      ),
      h(
        'div',
        {
          class:
            'mt-4 grid grid-cols-1 gap-4 min-[371px]:grid-cols-2 min-[761px]:grid-cols-1 min-[1001px]:grid-cols-2',
        },
        selectField(
          'calc-price-mode',
          'Stop and target inputs',
          [
            ['percent', 'Stop distance and risk : reward'],
            ['prices', 'Direct prices'],
          ],
          fields.priceMode,
          (value) => update('priceMode', value),
        ).element,
        numberField(
          'availableCapital',
          'Available capital (₹, optional)',
          'Blank uses planning capital. This limit must not exceed planning capital.',
        ),
        selectField(
          'calc-strategy',
          'Strategy snapshot',
          [
            ['', 'No strategy selected'],
            ...strategies.map((strategy) => [strategy.id, strategy.name]),
          ],
          state.strategyId,
          (value) => {
            state.strategyId = value;
            paintEstimate();
          },
        ).element,
      ),
      h(
        'p',
        { class: 'mt-4 text-xs leading-5 text-muted' },
        'Blank estimated costs use configured intraday rates; zero excludes fees. Delivery requires an explicit estimate when fees are enabled. Include applicable brokerage, taxes and depository charges.',
      ),
    ),
    h('div', { class: 'border-t border-line pt-4' }, quoteNote, refreshQuote),
  ),
);

const estimateCard = h(
  'div',
  {
    class:
      'min-w-0 rounded-card border border-line border-t-[3px] border-t-accent bg-surface p-4 min-[761px]:sticky min-[761px]:top-6 min-[761px]:p-5 min-[1001px]:p-[26px]',
  },
  h(
    'div',
    { class: 'mb-[23px] flex items-start justify-between gap-4' },
    h('h3', { class: 'text-base font-normal text-fg' }, 'Order estimate'),
    h(
      'span',
      {
        class:
          'shrink-0 rounded-sm border border-line px-2 py-1 font-mono text-[10px] tracking-wider text-muted',
      },
      'NOT SUBMITTED',
    ),
  ),
  estimate,
);

export const calculator = h(
  'div',
  {
    class:
      'mx-auto grid max-w-[1250px] grid-cols-1 items-start gap-[25px] min-[761px]:grid-cols-[minmax(0,1fr)_330px] min-[761px]:gap-[18px] min-[1001px]:grid-cols-[minmax(0,1.3fr)_minmax(330px,1fr)] min-[1001px]:gap-[25px] [&_input]:min-w-0 [&_input]:h-[43px] [&_input]:text-base [&_select]:min-w-0 [&_select]:h-[43px] [&_select]:text-base [&_label]:font-normal [&_label]:text-fg [&_label]:text-[13px]',
  },
  positionCard,
  estimateCard,
);
