/**
 * Full chart for the Live chart page, drawn with TradingView's open-source Lightweight Charts
 * (vendor script /vendor/lightweight-charts.js, global `LightweightCharts`): candles and volume,
 * crosshair with an OHLC legend, zoom and pan, intervals, and a last candle that moves with live
 * prices. Times are shown in IST. Follows the light/dark theme.
 */
import { h, render, buttonClass } from '../core/dom.js';
import { CHART_INTERVALS, fetchChartHistory } from '../lib/market-chart.js';
import { watchLiveQuotes } from '../lib/live-quotes.js';
import { applyLivePrice } from './market-history-chart.js';

const IST_OFFSET_S = 5.5 * 60 * 60;
const SOURCE_NAMES = { truedata: 'TrueData (live)', kite: 'Zerodha Kite', yahoo: 'Yahoo Finance' };
const LABELS = { '5m': '5m', '15m': '15m', '1h': '1H', '1d': '1D' };
const numberText = (value) =>
  Number.isFinite(value) ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';

// The library counts time in UTC seconds; shifting by IST shows Indian market hours.
const toBar = (candle) => ({
  time: Math.floor(candle.time / 1000) + IST_OFFSET_S,
  open: candle.open,
  high: candle.high,
  low: candle.low,
  close: candle.close,
});

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--color-surface', '#ffffff'),
    text: read('--color-muted', '#5f6c70'),
    grid: read('--color-line', '#e3e9e1'),
    up: read('--color-positive', '#446e47'),
    down: read('--color-negative', '#bb3348'),
  };
}

/** Creates the chart for `symbol`; returns { element, load, setSymbol, stop }. */
export function createProChart({ accountId, symbol: initialSymbol, initialInterval = '5m' }) {
  const library = window.LightweightCharts;
  let symbol = initialSymbol;
  let interval = initialInterval;
  let stopLive = () => undefined;
  let pending = null;
  let candles = [];

  const legend = h('div', { class: 'pro-chart-legend tnum', 'aria-live': 'off' });
  const status = h('p', { class: 'text-xs text-muted', role: 'status' });
  const intervals = h('div', { class: 'flex gap-1', role: 'group', 'aria-label': 'Interval' });
  const canvas = h('div', { class: 'pro-chart-canvas' });
  const element = h(
    'section',
    { class: 'pro-chart rounded-card border border-line bg-surface', 'aria-label': 'Price chart' },
    h('div', { class: 'pro-chart-toolbar' }, intervals, legend),
    canvas,
    h('div', { class: 'pro-chart-footer' }, status),
  );

  if (!library) {
    render(canvas, h('p', { class: 'p-6 text-sm text-muted' }, 'The chart could not load.'));
    return { element, load: async () => undefined, setSymbol: () => undefined, stop: () => {} };
  }

  const colors = themeColors();
  const chart = library.createChart(canvas, {
    autoSize: true,
    layout: {
      background: { color: colors.background },
      textColor: colors.text,
      fontFamily: 'inherit',
      attributionLogo: true,
    },
    grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
    crosshair: { mode: library.CrosshairMode.Normal },
    rightPriceScale: { borderColor: colors.grid },
    timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
    localization: { priceFormatter: numberText },
  });
  const series = chart.addSeries(library.CandlestickSeries, {
    upColor: colors.up,
    downColor: colors.down,
    wickUpColor: colors.up,
    wickDownColor: colors.down,
    borderVisible: false,
  });
  series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });
  const volume = chart.addSeries(library.HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  const volumeBar = (candle) => ({
    time: toBar(candle).time,
    value: candle.volume,
    color: `${candle.close >= candle.open ? colors.up : colors.down}55`,
  });

  function showLegend(bar) {
    const change = bar ? bar.close - bar.open : 0;
    render(
      legend,
      bar
        ? h(
            'span',
            {},
            h('strong', {}, `${symbol} · ${LABELS[interval]}`),
            ` O ${numberText(bar.open)} H ${numberText(bar.high)} L ${numberText(bar.low)} C `,
            h(
              'span',
              { class: change >= 0 ? 'text-positive' : 'text-negative' },
              `${numberText(bar.close)} (${change >= 0 ? '+' : ''}${numberText((change / bar.open) * 100)}%)`,
            ),
          )
        : h('strong', {}, `${symbol} · ${LABELS[interval]}`),
    );
  }
  chart.subscribeCrosshairMove((param) => {
    showLegend(param.seriesData?.get(series) ?? (candles.length ? toBar(candles.at(-1)) : null));
  });

  // Recolour when the member switches between light and dark.
  const themeWatch = new MutationObserver(() => {
    const next = themeColors();
    Object.assign(colors, next);
    chart.applyOptions({
      layout: { background: { color: next.background }, textColor: next.text },
      grid: { vertLines: { color: next.grid }, horzLines: { color: next.grid } },
    });
    series.applyOptions({
      upColor: next.up,
      downColor: next.down,
      wickUpColor: next.up,
      wickDownColor: next.down,
    });
    volume.setData(candles.map(volumeBar));
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  function paintIntervals(busy) {
    render(
      intervals,
      ...CHART_INTERVALS.map((value) =>
        h(
          'button',
          {
            type: 'button',
            class: buttonClass(value === interval ? 'default' : 'ghost', 'sm'),
            'aria-pressed': String(value === interval),
            disabled: busy,
            onclick: () => load(value),
          },
          LABELS[value],
        ),
      ),
    );
  }

  async function load(next = interval) {
    stopLive();
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    interval = next;
    paintIntervals(true);
    status.textContent = 'Loading candles…';
    try {
      const history = await fetchChartHistory(accountId, symbol, interval, controller.signal);
      if (pending !== controller) return;
      candles = history.candles;
      series.setData(candles.map(toBar));
      volume.setData(candles.map(volumeBar));
      chart.timeScale().fitContent();
      showLegend(toBar(candles.at(-1)));
      status.textContent = `${SOURCE_NAMES[history.source]} · times in IST · scroll to zoom, drag to pan.`;
      const chartInterval = interval;
      stopLive = watchLiveQuotes([symbol], (_symbol, price, at) => {
        // Only prices traded in the last two minutes move the chart (none after the close).
        if (Date.now() - at > 2 * 60_000) return;
        applyLivePrice(candles, chartInterval, price, at);
        const last = candles.at(-1);
        series.update(toBar(last));
        volume.update(volumeBar(last));
        showLegend(toBar(last));
        status.textContent = `Live · ${numberText(price)} · ${SOURCE_NAMES[history.source]} history · times in IST.`;
      });
    } catch (failure) {
      if (pending !== controller) return;
      series.setData([]);
      volume.setData([]);
      candles = [];
      showLegend(null);
      status.textContent =
        failure instanceof Error && /limited/.test(failure.message)
          ? failure.message
          : `No chart data for ${symbol}. Check the symbol (NSE, e.g. RELIANCE) and try again.`;
    } finally {
      if (pending === controller) {
        pending = null;
        paintIntervals(false);
      }
    }
  }

  paintIntervals(false);
  showLegend(null);
  return {
    element,
    load: () => load(interval),
    setSymbol(next) {
      symbol = next;
      void load(interval);
    },
    /** Stops following live prices (when the page goes away); load() starts again. */
    stop: () => stopLive(),
  };
}
