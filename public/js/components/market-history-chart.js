/**
 * Price history chart for one instrument: interval picker, candlestick plot
 * and keyboard/pointer inspection of individual candles.
 */
import { h, icon, buttonClass, render } from '../core/dom.js';
import { CHART_INTERVALS, fetchChartHistory } from '../lib/market-chart.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const dateText = (time) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(time);
const numberText = (value) => value.toLocaleString('en-IN', { maximumFractionDigits: 4 });

function svg(tag, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * Interactive candlestick plot: pointer and arrow keys inspect individual candles.
 * `marks` (trade replay) draws price lines `{ price, label, kind }` and points
 * `{ time, price, label, kind }` on the nearest candle; kind is entry, exit or stop.
 */
export function candlePlot(candles, symbol, marks = {}) {
  const visible = candles.slice(-120);
  let selected = visible.length - 1;
  const lines = marks.lines ?? [];
  const minimum = Math.min(...visible.map((c) => c.low), ...lines.map((line) => line.price));
  const maximum = Math.max(...visible.map((c) => c.high), ...lines.map((line) => line.price));
  const padding = Math.max((maximum - minimum) * 0.08, maximum * 0.001, 0.0001);
  const low = Math.max(0, minimum - padding);
  const high = maximum + padding;
  const y = (price) => 210 - ((price - low) / (high - low)) * 190;
  const x = (index) => 20 + ((index + 0.5) / visible.length) * 600;
  const width = Math.max(1, Math.min(16, 420 / visible.length));
  const descriptionId = `candle-description-${Math.random().toString(36).slice(2)}`;
  const plot = svg('svg', { viewBox: '0 0 720 245', 'aria-hidden': 'true' });
  for (const fraction of [0, 0.5, 1]) {
    plot.append(
      svg('line', {
        x1: 20,
        x2: 620,
        y1: 20 + fraction * 190,
        y2: 20 + fraction * 190,
        class: 'reference-candle-grid',
      }),
      svg('text', { x: 630, y: 24 + fraction * 190 }, numberText(high - fraction * (high - low))),
    );
  }
  visible.forEach((c, i) => {
    const group = svg('g', {
      class: c.close >= c.open ? 'reference-candle-up' : 'reference-candle-down',
    });
    group.append(
      svg('line', { x1: x(i), x2: x(i), y1: y(c.high), y2: y(c.low) }),
      svg('rect', {
        x: x(i) - width / 2,
        y: y(Math.max(c.open, c.close)),
        width,
        height: Math.max(1, Math.abs(y(c.open) - y(c.close))),
      }),
    );
    plot.append(group);
  });
  for (const line of lines) {
    plot.append(
      svg('line', {
        x1: 20,
        x2: 620,
        y1: y(line.price),
        y2: y(line.price),
        class: `reference-mark-line reference-mark-${line.kind}`,
      }),
      svg(
        'text',
        { x: 24, y: y(line.price) - 4, class: `reference-mark-label reference-mark-${line.kind}` },
        `${line.label} ${numberText(line.price)}`,
      ),
    );
  }
  for (const point of marks.points ?? []) {
    // The candle that contains the time: the last one starting at or before it.
    const index = visible.findLastIndex((c) => c.time <= point.time);
    if (index < 0) continue;
    plot.append(
      svg('circle', {
        cx: x(index),
        cy: y(point.price),
        r: 5,
        class: `reference-mark-${point.kind}`,
      }),
    );
  }
  const cursor = svg('line', {
    x1: x(selected),
    x2: x(selected),
    y1: 15,
    y2: 215,
    class: 'reference-candle-cursor',
  });
  plot.append(
    cursor,
    svg('text', { x: 20, y: 238 }, dateText(visible[0].time)),
    svg('text', { x: 620, y: 238, 'text-anchor': 'end' }, `${dateText(visible.at(-1).time)} IST`),
  );
  const details = h('p', { class: 'reference-candle-details' });
  const slider = h(
    'div',
    {
      role: 'slider',
      tabindex: '0',
      class: 'focus-ring reference-candle-interaction',
      'aria-label': `${symbol} historical candle`,
      'aria-valuemin': '1',
      'aria-valuemax': String(visible.length),
      'aria-describedby': descriptionId,
    },
    plot,
  );
  const paint = () => {
    const active = visible[selected];
    const description = `${dateText(active.time)} IST. Open ${numberText(active.open)}, high ${numberText(active.high)}, low ${numberText(active.low)}, close ${numberText(active.close)}, volume ${numberText(active.volume)}.`;
    cursor.setAttribute('x1', x(selected));
    cursor.setAttribute('x2', x(selected));
    slider.setAttribute('aria-valuenow', String(selected + 1));
    slider.setAttribute('aria-valuetext', description);
    details.textContent = description;
  };
  slider.addEventListener('keydown', (event) => {
    const delta =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? 1
          : 0;
    if (delta) {
      event.preventDefault();
      selected = Math.max(0, Math.min(visible.length - 1, selected + delta));
      paint();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      selected = event.key === 'Home' ? 0 : visible.length - 1;
      paint();
    }
  });
  plot.addEventListener('pointermove', (event) => {
    const box = plot.getBoundingClientRect();
    if (!box.width) return;
    const position = (((event.clientX - box.left) / box.width) * 720 - 20) / 600;
    selected = Math.max(0, Math.min(visible.length - 1, Math.floor(position * visible.length)));
    paint();
  });
  paint();
  return h(
    'div',
    { class: 'reference-candles' },
    h(
      'p',
      { class: 'reference-history-note' },
      `Visible price range ${numberText(minimum)}–${numberText(maximum)}.`,
    ),
    slider,
    h(
      'p',
      { id: descriptionId, class: 'reference-history-note' },
      `Use arrow keys to inspect candles. Showing ${visible.length} of ${candles.length} returned candles.`,
    ),
    details,
  );
}

/**
 * Explicitly refreshed historical candle snapshots with provider provenance.
 * Returns `{ element, setSymbol }`; changing the symbol resets the chart.
 */
export function createMarketHistoryChart({ accountId, symbol: initialSymbol, available = true }) {
  let symbol = initialSymbol;
  let interval = '1d';
  let requests = 0;
  let pending = null;
  const section = h('section', {
    class: 'reference-history-chart',
    'aria-label': 'Historical market chart',
  });
  const intervals = h('div', {
    class: 'reference-intervals',
    role: 'group',
    'aria-label': 'Historical candle intervals',
  });
  const refresh = h('button', { type: 'button', class: buttonClass('outline', 'sm') });
  const note = h('p', { class: 'reference-history-note' });
  const body = h('div');
  section.append(h('div', { class: 'reference-history-controls' }, intervals, refresh), note, body);

  const allowed = () => Boolean(accountId && symbol && available);
  const placeholder = (title, text) =>
    h(
      'div',
      { class: 'reference-chart-unavailable', role: 'status' },
      icon('bar-chart-3', 30),
      h('h4', {}, title),
      h('p', {}, text),
    );
  const paintControls = (loading) => {
    render(
      intervals,
      ...CHART_INTERVALS.map((value) =>
        h(
          'button',
          {
            type: 'button',
            class: 'focus-ring',
            disabled: !allowed(),
            'aria-pressed': String(interval === value),
            onclick: () => load(value),
          },
          value,
        ),
      ),
    );
    refresh.disabled = !allowed() || loading;
    render(
      refresh,
      icon('refresh-cw', 13, loading ? 'animate-spin' : ''),
      requests ? ' Refresh chart' : ' Load history',
    );
    note.textContent = `Historical candle snapshot · ${interval === '1d' ? '180 calendar days' : '7 calendar days'} · Refresh manually. Provider delays and gaps may occur.`;
  };
  const idle = () => {
    render(
      body,
      symbol
        ? placeholder(
            'Explore candle history',
            'Choose an interval or load the daily history for this instrument.',
          )
        : placeholder(
            'Select an instrument',
            'Add an instrument to your watchlist to view its history.',
          ),
    );
    paintControls(false);
  };
  async function load(next) {
    if (!allowed()) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    interval = next;
    requests += 1;
    paintControls(true);
    render(
      body,
      placeholder('Loading candle history…', 'Checking the available historical source.'),
    );
    const timer = setTimeout(() => {
      if (pending !== controller) return;
      controller.abort();
      pending = null;
      paintControls(false);
      render(body, placeholder('Chart history unavailable', 'Chart history timed out. Try again.'));
    }, 20_000);
    try {
      const history = await fetchChartHistory(accountId, symbol, interval, controller.signal);
      if (controller.signal.aborted || pending !== controller) return;
      render(
        body,
        candlePlot(history.candles, symbol),
        h(
          'p',
          { class: 'reference-history-note' },
          `${history.source === 'kite' ? 'Zerodha Kite' : 'Yahoo Finance'} · ${history.currency || 'Currency unavailable'} · Last candle ${dateText(history.candles.at(-1).time)} IST. The latest candle may still be forming.`,
        ),
      );
    } catch (failure) {
      if (controller.signal.aborted || pending !== controller) return;
      render(
        body,
        placeholder(
          'Chart history unavailable',
          failure instanceof Error &&
            failure.message === 'Chart requests are limited. Try again later.'
            ? failure.message
            : 'Chart history is unavailable or could not be verified. Try again.',
        ),
      );
    } finally {
      clearTimeout(timer);
      if (pending === controller) {
        pending = null;
        paintControls(false);
      }
    }
  }
  refresh.addEventListener('click', () => load(interval));
  idle();
  return {
    element: section,
    setSymbol(next) {
      if (next === symbol) return;
      pending?.abort();
      pending = null;
      symbol = next;
      interval = '1d';
      requests = 0;
      idle();
    },
  };
}
