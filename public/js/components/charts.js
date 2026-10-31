/**
 * Chart.js area, bar and multi-line charts in the app's colours. Colours follow
 * the semantic tokens, so the theme toggle repaints every chart.
 */
import { formatCurrency } from '../core/dom.js';

export const CHART_POSITIVE = '#446e47';
export const CHART_NEGATIVE = '#bb3348';
const charts = new Set();

function token(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Default y-axis tick format: rupees rounded to thousands, e.g. "₹12k". */
export const thousands = (value) => `₹${Math.round(Number(value) / 1000)}k`;

function baseOptions({ yFormatter, tooltip, showX = false, xFormatter }) {
  const muted = token('--color-muted', '#5f6c70');
  const grid = token('--color-line', '#dce4da');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => tooltip(context.parsed.y, context) } },
    },
    scales: {
      x: {
        display: showX,
        grid: { display: false },
        ticks: { color: muted, font: { size: 10 }, autoSkip: false, callback: xFormatter },
      },
      y: {
        grid: { color: grid, drawTicks: false },
        border: { display: false },
        ticks: { color: muted, font: { size: 11 }, callback: yFormatter },
      },
    },
  };
}

function mount(canvas, config) {
  if (!window.Chart) return null;
  const existing = window.Chart.getChart(canvas);
  existing?.destroy();
  const chart = new window.Chart(canvas, config);
  charts.add(chart);
  return chart;
}

/**
 * Single-series line chart with a gradient fill on the canvas (replacing any chart already on it).
 * Returns the Chart instance, or null when Chart.js is not loaded.
 */
export function areaChart(
  canvas,
  { labels, values, color, tooltipLabel, yFormatter = thousands, fillOpacity = 0.15 },
) {
  const stroke = color || token('--color-accent', '#446e47');
  return mount(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: values,
          borderColor: stroke,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
          backgroundColor: (context) => {
            const { chart } = context;
            const area = chart.chartArea;
            if (!area) return 'transparent';
            const gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            gradient.addColorStop(
              0,
              `${stroke}${Math.round(fillOpacity * 255)
                .toString(16)
                .padStart(2, '0')}`,
            );
            gradient.addColorStop(1, `${stroke}00`);
            return gradient;
          },
        },
      ],
    },
    options: baseOptions({
      yFormatter,
      tooltip: (value) => `${tooltipLabel}: ${formatCurrency(Number(value))}`,
    }),
  });
}

/**
 * Bar chart with per-bar `colors` and a `tooltip(value, context)` label function; `integer`
 * shows whole-number y ticks only. Returns the Chart instance, or null without Chart.js.
 */
export function barChart(
  canvas,
  {
    labels,
    values,
    colors,
    tooltip,
    yFormatter = thousands,
    showX = true,
    xFormatter,
    integer = false,
  },
) {
  return mount(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderRadius: { topLeft: 3, topRight: 3 },
          borderSkipped: 'bottom',
        },
      ],
    },
    options: {
      ...baseOptions({
        yFormatter: integer ? (value) => (Number.isInteger(value) ? value : '') : yFormatter,
        tooltip,
        showX,
        xFormatter: xFormatter
          ? function format(value) {
              return xFormatter(this.getLabelForValue(value));
            }
          : undefined,
      }),
    },
  });
}

/** Distinguishable line colours for several series (strategies, for example). */
export const SERIES_COLORS = ['#446e47', '#2f6fb3', '#ab4d26', '#8e44ad', '#bb3348', '#5f6c70'];

/**
 * Several lines over shared x labels, with a legend. Each series:
 * { label, values (aligned with labels; null for gaps), color? }.
 */
export function lineChart(canvas, { labels, series, yFormatter = thousands }) {
  const options = baseOptions({
    yFormatter,
    tooltip: (value, context) =>
      `${context.dataset.label}: ${value === null ? '—' : formatCurrency(Number(value))}`,
    showX: true,
    xFormatter: function format(value) {
      const text = this.getLabelForValue(value);
      return value === 0 || value === labels.length - 1 ? text : '';
    },
  });
  options.plugins.legend = {
    display: true,
    position: 'bottom',
    labels: { boxWidth: 10, color: token('--color-muted', '#5f6c70'), font: { size: 11 } },
  };
  return mount(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((line, index) => ({
        label: line.label,
        data: line.values,
        borderColor: line.color || SERIES_COLORS[index % SERIES_COLORS.length],
        backgroundColor: line.color || SERIES_COLORS[index % SERIES_COLORS.length],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: true,
      })),
    },
    options,
  });
}

document.addEventListener('blank:theme-changed', () => {
  for (const chart of charts) {
    if (!chart.canvas?.isConnected) {
      charts.delete(chart);
      continue;
    }
    const muted = token('--color-muted', '#5f6c70');
    const grid = token('--color-line', '#dce4da');
    chart.options.scales.x.ticks.color = muted;
    chart.options.scales.y.ticks.color = muted;
    chart.options.scales.y.grid.color = grid;
    chart.update('none');
  }
});
