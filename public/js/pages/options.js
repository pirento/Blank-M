/**
 * Options payoff page: build a strategy of up to six F&O legs, then see the
 * payoff at expiry and today, breakevens, max profit/loss and position Greeks.
 * A pure browser tool: the maths is shared/options.js and the inputs are only
 * remembered in this browser (localStorage).
 */
import { t } from '../core/i18n.js';
import {
  $,
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
  formatCurrency,
  render,
  statCard,
  icon,
} from '../core/dom.js';
import { signedCurrency as signed, pnlTone as tone } from '../core/format.js';
import {
  DEFAULT_LOT_SIZE,
  DEFAULT_RATE,
  MAX_LEGS,
  PRESETS,
  legGreeks,
  netPremium,
  payoffCurve,
  payoffSummary,
  presetLegs,
  strategyGreeks,
  validateStrategy,
} from '../../../shared/options.js';

const STORAGE_KEY = 'blank_options_builder';
const SVG_NS = 'http://www.w3.org/2000/svg';
const root = $('[data-options]');

/* ------------------------------------- state ------------------------------------- */

const asText = (leg) => Object.fromEntries(Object.entries(leg).map(([k, v]) => [k, String(v)]));
const DEFAULT_MARKET = { spot: '24000', days: '7', iv: '14', rate: String(DEFAULT_RATE) };

/** Saved inputs from an earlier visit, or a long call at the money. */
function loadState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && Array.isArray(saved.legs) && saved.legs.length <= MAX_LEGS) {
      return {
        ...Object.fromEntries(
          Object.keys(DEFAULT_MARKET).map((key) => [key, String(saved[key] ?? '')]),
        ),
        legs: saved.legs.map((leg) => asText(leg ?? {})),
      };
    }
  } catch {
    // Storage blocked or unreadable: start fresh.
  }
  return {
    ...DEFAULT_MARKET,
    legs: presetLegs('long-call', { spot: 24000, days: 7, iv: 14, rate: DEFAULT_RATE }).map(asText),
  };
}

const state = loadState();
const save = () => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or full storage: the tool still works for this visit.
  }
};

/* ------------------------------------- fields ------------------------------------ */

const controls = new Map(); // field key → { control, error }

/** A labelled input bound to `target[name]`, with an error line the validation fills. */
function numberField(key, text, target, name, attributes = {}) {
  const id = `options-${key.replace(/\./g, '-')}`;
  const error = h('p', { id: `${id}-error`, class: 'mt-1 text-xs text-negative', role: 'alert' });
  const control = input({
    id,
    type: 'number',
    inputmode: 'decimal',
    step: 'any',
    value: target[name],
    'aria-describedby': error.id,
    oninput: (event) => {
      target[name] = event.target.value;
      update();
    },
    ...attributes,
  });
  controls.set(key, { control, error });
  return h('div', {}, label(text, id), control, error);
}

function choiceField(key, text, target, name, options) {
  const id = `options-${key.replace(/\./g, '-')}`;
  const control = select(
    {
      id,
      onchange: (event) => {
        target[name] = event.target.value;
        if (name === 'kind') paintLegs(); // a future has no strike, so the leg's fields change
        update();
        $(`#${id}`)?.focus();
      },
    },
    options.map(([value, optionLabel]) => ({
      value,
      label: optionLabel,
      selected: target[name] === value,
    })),
  );
  return h('div', {}, label(text, id), control);
}

const marketForm = h('div', { class: 'grid grid-cols-2 gap-4 sm:grid-cols-4' });
const legsList = h('div', { class: 'space-y-3' });
const presetError = h('p', { class: 'text-xs text-negative', role: 'alert' });
const addButton = button([icon('plus', 14, 'mr-2'), t('Add leg')], {
  variant: 'outline',
  size: 'sm',
  onclick: () => {
    state.legs.push({
      side: 'buy',
      kind: 'call',
      strike: state.legs.at(-1)?.strike ?? state.spot,
      premium: '',
      lots: '1',
      lotSize: state.legs.at(-1)?.lotSize ?? String(DEFAULT_LOT_SIZE),
    });
    paintLegs();
    update();
    $(`#options-legs-${state.legs.length - 1}-premium`)?.focus();
  },
});

function paintMarket() {
  render(
    marketForm,
    numberField('spot', t('Underlying price'), state, 'spot', { min: '0' }),
    numberField('days', t('Days to expiry'), state, 'days', { min: '0', step: '1' }),
    numberField('iv', t('Implied volatility %'), state, 'iv', { min: '0' }),
    numberField('rate', t('Risk-free rate %'), state, 'rate', { min: '0' }),
  );
}

function paintLegs() {
  for (const key of [...controls.keys()]) if (key.startsWith('legs.')) controls.delete(key);
  render(
    legsList,
    state.legs.map((leg, index) => {
      const key = (field) => `legs.${index}.${field}`;
      return h(
        'fieldset',
        { class: 'min-w-0 rounded-card border border-line p-3' },
        h('legend', { class: 'px-1 text-xs font-medium text-muted' }, `${t('Leg')} ${index + 1}`),
        h(
          'div',
          { class: 'grid grid-cols-2 items-start gap-3 sm:grid-cols-3 lg:grid-cols-7' },
          choiceField(key('side'), 'Buy / Sell', leg, 'side', [
            ['buy', 'Buy'],
            ['sell', 'Sell'],
          ]),
          choiceField(key('kind'), 'Type', leg, 'kind', [
            ['call', 'Call (CE)'],
            ['put', 'Put (PE)'],
            ['future', 'Future'],
          ]),
          leg.kind === 'future'
            ? h(
                'div',
                {},
                label('Strike', `options-legs-${index}-strike`),
                input({ id: `options-legs-${index}-strike`, disabled: true, value: '—' }),
              )
            : numberField(key('strike'), 'Strike', leg, 'strike', { min: '0' }),
          numberField(
            key('premium'),
            leg.kind === 'future' ? 'Entry price' : 'Premium',
            leg,
            'premium',
            { min: '0' },
          ),
          numberField(key('lots'), 'Lots', leg, 'lots', { min: '1', step: '1' }),
          numberField(key('lotSize'), 'Lot size', leg, 'lotSize', { min: '1', step: '1' }),
          h(
            'div',
            { class: 'flex h-full items-end pb-0.5' },
            button([icon('trash-2', 14, 'mr-2'), 'Remove'], {
              variant: 'ghost',
              size: 'sm',
              'aria-label': `Remove leg ${index + 1}`,
              onclick: () => {
                state.legs.splice(index, 1);
                paintLegs();
                update();
              },
            }),
          ),
        ),
      );
    }),
  );
  addButton.disabled = state.legs.length >= MAX_LEGS;
}

function applyPreset(name) {
  // A placeholder leg so only the market inputs decide whether the preset can be priced.
  const { market } = validateStrategy({
    ...state,
    legs: [{ strike: 1, premium: 0, lots: 1, lotSize: 1 }],
  });
  presetError.textContent = market
    ? ''
    : 'Fix the market inputs above first; presets are priced from them.';
  if (!market) return;
  const lotSize = Number.parseInt(state.legs[0]?.lotSize, 10);
  state.legs = presetLegs(name, market, lotSize > 0 ? lotSize : DEFAULT_LOT_SIZE).map(asText);
  paintLegs();
  update();
}

/* ------------------------------------- chart ------------------------------------- */

function svg(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) element.setAttribute(key, String(value));
  }
  if (text !== undefined) element.textContent = text;
  return element;
}

const price = (value) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const compact = (value) =>
  Math.abs(value) >= 1000 ? `₹${(value / 1000).toFixed(1)}k` : `₹${Math.round(value)}`;

/**
 * Payoff chart: expiry P&L (solid, green above zero, red below), today's
 * Black-Scholes P&L (dashed), spot and breakeven lines, and a slider that
 * reads both curves at any price (the chart itself is hidden from screen
 * readers; the slider and the summary carry the same facts as text).
 */
function payoffChart(curve, { spot, breakevens }) {
  const [width, height, left, right, top, bottom] = [720, 320, 8, 64, 16, 36];
  const values = curve.flatMap((point) => [point.expiry, point.today]);
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  const pad = (high - low) * 0.08 || 1;
  low -= pad;
  high += pad;
  const from = curve[0].price;
  const to = curve.at(-1).price;
  const x = (value) => left + ((value - from) / (to - from)) * (width - left - right);
  const y = (value) => top + ((high - value) / (high - low)) * (height - top - bottom);
  const path = (key) =>
    curve
      .map(
        (point, index) =>
          `${index ? 'L' : 'M'}${x(point.price).toFixed(1)},${y(point[key]).toFixed(1)}`,
      )
      .join(' ');
  const zero = y(0);
  const id = Math.random().toString(36).slice(2);
  const plot = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'block h-auto w-full',
    'aria-hidden': 'true',
  });
  const axisText = (attributes, text) =>
    svg(
      'text',
      { style: 'fill: var(--color-muted); font: 13px var(--font-mono)', ...attributes },
      text,
    );
  // Profit and loss: the area under the expiry line, clipped above and below zero.
  const clip = (name, y0, y1) => {
    const element = svg('clipPath', { id: `${name}-${id}` });
    element.append(svg('rect', { x: 0, y: y0, width, height: Math.max(0, y1 - y0) }));
    return element;
  };
  const defs = svg('defs');
  defs.append(clip('above', 0, zero), clip('below', zero, height));
  const area = `${path('expiry')} L${x(to)},${zero} L${x(from)},${zero} Z`;
  const shape = (d, side, style) =>
    svg('path', { d, 'clip-path': side ? `url(#${side}-${id})` : undefined, style });
  plot.append(
    defs,
    svg('line', {
      x1: left,
      x2: width - right,
      y1: zero,
      y2: zero,
      style: 'stroke: var(--color-line-strong); stroke-width: 1',
    }),
    axisText({ x: width - right + 6, y: y(high - pad) + 4 }, compact(high - pad)),
    axisText({ x: width - right + 6, y: zero + 4 }, '₹0'),
    axisText({ x: width - right + 6, y: y(low + pad) + 4 }, compact(low + pad)),
    axisText({ x: left, y: height - 10 }, price(from)),
    axisText({ x: width - right, y: height - 10, 'text-anchor': 'end' }, price(to)),
    shape(area, 'above', 'fill: var(--color-positive); opacity: 0.14'),
    shape(area, 'below', 'fill: var(--color-negative); opacity: 0.14'),
    shape(path('expiry'), 'above', 'fill: none; stroke: var(--color-positive); stroke-width: 2.5'),
    shape(path('expiry'), 'below', 'fill: none; stroke: var(--color-negative); stroke-width: 2.5'),
    shape(
      path('today'),
      null,
      'fill: none; stroke: var(--color-fg); stroke-width: 1.5; stroke-dasharray: 6 5',
    ),
  );
  const marker = (at, text, dash) => {
    if (at < from || at > to) return;
    plot.append(
      svg('line', {
        x1: x(at),
        x2: x(at),
        y1: top,
        y2: height - bottom,
        style: `stroke: var(--color-muted); stroke-width: 1; stroke-dasharray: ${dash}`,
      }),
      axisText(
        {
          x: x(at),
          y: top + 12,
          'text-anchor': 'middle',
          style: 'fill: var(--color-fg); font: 13px var(--font-mono)',
        },
        text,
      ),
    );
  };
  marker(spot, `Spot ${price(spot)}`, '2 3');
  for (const breakeven of breakevens) marker(breakeven, '', '1 4');
  const cursor = svg('line', {
    y1: top,
    y2: height - bottom,
    style: 'stroke: var(--color-fg); stroke-width: 1',
  });
  plot.append(cursor);

  // Price slider: reads both curves at the chosen point (keyboard and touch friendly).
  const readout = h('p', { class: 'tnum text-sm text-fg', 'aria-live': 'polite' });
  const spotIndex = curve.reduce(
    (best, point, index) =>
      Math.abs(point.price - spot) < Math.abs(curve[best].price - spot) ? index : best,
    0,
  );
  const slider = h('input', {
    id: 'options-inspect',
    type: 'range',
    min: '0',
    max: String(curve.length - 1),
    step: '1',
    value: String(spotIndex),
    class: 'w-full accent-accent',
    oninput: () => show(Number(slider.value)),
  });
  const show = (index) => {
    const point = curve[index];
    cursor.setAttribute('x1', x(point.price));
    cursor.setAttribute('x2', x(point.price));
    const text = `At ${price(point.price)}: expiry ${signed(point.expiry)}, today ${signed(point.today)}`;
    readout.textContent = text;
    slider.setAttribute('aria-valuetext', text);
  };
  plot.addEventListener('pointermove', (event) => {
    const box = plot.getBoundingClientRect();
    if (!box.width) return;
    const at =
      from +
      ((((event.clientX - box.left) / box.width) * width - left) / (width - left - right)) *
        (to - from);
    const index = Math.round(((at - from) / (to - from)) * (curve.length - 1));
    slider.value = String(Math.max(0, Math.min(curve.length - 1, index)));
    show(Number(slider.value));
  });
  show(spotIndex);
  return h(
    'div',
    { class: 'space-y-3' },
    h(
      'div',
      { class: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted' },
      h('span', {}, '— At expiry'),
      h('span', {}, '- - Today (Black-Scholes)'),
      h('span', {}, '┆ Spot and breakevens'),
    ),
    h('div', { class: 'rounded-control border border-line bg-canvas' }, plot),
    h('div', {}, label('Inspect a price', slider.id), slider),
    readout,
  );
}

/* ------------------------------------ results ------------------------------------ */

const results = h('div', { class: 'space-y-6' });
const limit = (value) => (Number.isFinite(value) ? signed(value) : 'Unlimited');
const greek = (value, digits = 2) =>
  (Math.abs(value) < 1e-9 ? 0 : value).toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const legName = (leg, index) =>
  `${index + 1}. ${leg.side === 'buy' ? 'Buy' : 'Sell'} ${leg.lots}×${leg.lotSize} ${
    leg.kind === 'future' ? 'FUT' : `${price(leg.strike)} ${leg.kind === 'call' ? 'CE' : 'PE'}`
  }`;

function greeksTable(legs, market) {
  const total = strategyGreeks(legs, market);
  const row = (name, values, strong) =>
    h(
      'tr',
      { class: cn('border-b border-line last:border-0', strong && 'font-medium') },
      h('td', { class: 'py-2 pr-3 text-fg' }, name),
      h('td', { class: 'py-2 pr-3 text-right' }, values.price === null ? '' : price(values.price)),
      h('td', { class: cn('py-2 pr-3 text-right', tone(values.pnl)) }, signed(values.pnl)),
      h('td', { class: 'py-2 pr-3 text-right' }, greek(values.delta)),
      h('td', { class: 'py-2 pr-3 text-right' }, greek(values.gamma, 4)),
      h('td', { class: cn('py-2 pr-3 text-right', tone(values.theta)) }, greek(values.theta)),
      h('td', { class: 'py-2 text-right' }, greek(values.vega)),
    );
  return h(
    'div',
    { class: 'overflow-x-auto' },
    h(
      'table',
      { class: 'stack-table w-full min-w-[640px] tnum text-sm' },
      h(
        'thead',
        { class: 'border-b border-line text-left text-xs uppercase tracking-wide text-muted' },
        h(
          'tr',
          {},
          ['Leg', 'Value now', 'P&L now', 'Delta', 'Gamma', 'Theta ₹/day', 'Vega ₹/1% IV'].map(
            (text, index) => h('th', { class: cn('py-2 pr-3', index > 0 && 'text-right') }, text),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        legs.map((leg, index) => row(legName(leg, index), legGreeks(leg, market))),
        row('Total', { ...total, price: null }, true),
      ),
    ),
  );
}

function update() {
  save();
  const { errors, market, legs } = validateStrategy(state);
  for (const [key, { control, error }] of controls) {
    const message = errors[key] ?? '';
    error.textContent = message;
    control.classList.toggle('border-negative', Boolean(message));
    control.classList.toggle('border-line-strong', !message);
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  if (!legs) {
    const count = Object.keys(errors).length;
    render(
      results,
      h(
        'p',
        {
          role: 'status',
          class: 'rounded-card border border-line bg-surface p-4 text-sm text-negative',
        },
        errors.legs ??
          `${count} ${count === 1 ? 'input needs' : 'inputs need'} fixing before the payoff can be drawn.`,
      ),
    );
    return;
  }
  const summary = payoffSummary(legs);
  const premium = netPremium(legs);
  const curve = payoffCurve(legs, market, {
    from: market.spot * 0.85,
    to: market.spot * 1.15,
    points: 201,
  });
  render(
    results,
    h(
      'div',
      { class: 'grid grid-cols-2 gap-3 lg:grid-cols-4' },
      statCard({
        label: 'Max profit',
        value: limit(summary.maxProfit),
        tone: summary.maxProfit > 0 ? 'positive' : 'neutral',
        hint: 'At expiry',
      }),
      statCard({
        label: 'Max loss',
        value: limit(summary.maxLoss),
        tone: summary.maxLoss < 0 ? 'negative' : 'neutral',
        hint: 'At expiry',
      }),
      statCard({
        label: 'Breakevens',
        value: summary.breakevens.length ? summary.breakevens.map(price).join(' · ') : 'None',
        hint: 'Underlying price at expiry',
      }),
      statCard({
        label: premium >= 0 ? 'Net premium received' : 'Net premium paid',
        value: formatCurrency(Math.abs(premium)),
        tone: premium >= 0 ? 'positive' : 'negative',
        hint: 'Before charges',
      }),
    ),
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Payoff')),
          h(
            'p',
            { class: 'mt-1 text-sm text-muted' },
            `P&L from ${price(market.spot * 0.85)} to ${price(market.spot * 1.15)} (±15% of spot). Max profit and loss look beyond this range.`,
          ),
        ),
      ),
      cardContent('', payoffChart(curve, { spot: market.spot, breakevens: summary.breakevens })),
    ),
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Greeks')),
          h(
            'p',
            { class: 'mt-1 text-sm text-muted' },
            'Black-Scholes (European, no dividends) for the whole position: lots × lot size, negative when sold. Delta is in units of the underlying.',
          ),
        ),
      ),
      cardContent('', greeksTable(legs, market)),
    ),
  );
}

/* ------------------------------------- start ------------------------------------- */

paintMarket();
paintLegs();
render(
  root,
  card({}, cardHeader('', cardTitle(t('Market'))), cardContent('space-y-4', marketForm)),
  card(
    {},
    cardHeader(
      'flex-wrap',
      cardTitle(t('Legs')),
      h(
        'div',
        { class: 'flex flex-wrap gap-2', role: 'group', 'aria-label': 'Strategy presets' },
        Object.entries(PRESETS).map(([name, text]) =>
          button(text, { variant: 'outline', size: 'sm', onclick: () => applyPreset(name) }),
        ),
      ),
    ),
    cardContent(
      'space-y-3',
      presetError,
      legsList,
      addButton,
      h(
        'p',
        { class: 'text-xs leading-5 text-muted' },
        `Presets use strikes in steps of 50 around spot and price each leg at today’s Black-Scholes value. Lot size ${DEFAULT_LOT_SIZE} is NIFTY’s; change it for other underlyings. Charges and margin are not included.`,
      ),
    ),
  ),
  results,
);
update();
