/**
 * Insights page: the AI coach, P&L calendar, weekday results, mistake cost,
 * setups and emotions, R-multiples and per-strategy equity curves. All figures come from
 * shared/insights.js over the member's net P&L.
 */
import { signedCurrency as signed, pnlTone as tone } from '../core/format.js';
import {
  $,
  h,
  cn,
  pageData,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  emptyState,
  formatCurrency,
  render,
  statCard,
} from '../core/dom.js';
import { todayInIst } from '../../../shared/market.js';
import {
  emotionStats,
  mistakeSummary,
  rStats,
  strategyCurves,
  tagStats,
  weekdayStats,
} from '../../../shared/insights.js';
import { EMOTIONS } from '../../../shared/trade-tags.js';
import { pnlCalendar } from '../components/pnl-calendar.js';
import { createCoachReview } from '../components/coach-review.js';
import {
  CHART_NEGATIVE,
  CHART_POSITIVE,
  barChart,
  lineChart,
  thousands,
} from '../components/charts.js';

const data = pageData();
const workspace = data.workspace ?? { trades: [], strategies: [] };
const root = $('[data-insights]');
const periodSelect = $('[data-period]');

/** Axis labels: whole rupees below ₹1,000 ("₹0k" would hide small journals), else thousands. */
const axisRupees = (value) =>
  Math.abs(Number(value)) >= 1000 ? thousands(value) : `₹${Math.round(Number(value))}`;
const emotionLabel = (value) => EMOTIONS.find((emotion) => emotion.value === value)?.label ?? value;

/** Trades inside the selected period (dates are IST calendar dates). */
function periodTrades(period) {
  const today = todayInIst();
  const start =
    period === 'ytd'
      ? `${today.slice(0, 4)}-01-01`
      : period === '90d' || period === '30d'
        ? new Date(Date.parse(`${today}T00:00:00Z`) - (period === '90d' ? 89 : 29) * 86400000)
            .toISOString()
            .slice(0, 10)
        : '';
  return workspace.trades.filter((trade) => !start || trade.date >= start);
}

function section(title, subtitle, ...children) {
  return card(
    {},
    cardHeader(
      '',
      h(
        'div',
        {},
        cardTitle(title),
        subtitle ? h('p', { class: 'mt-1 text-sm text-muted' }, subtitle) : null,
      ),
    ),
    cardContent('space-y-4', ...children),
  );
}

function canvasBox(height) {
  const canvas = h('canvas');
  return { canvas, box: h('div', { class: 'w-full', style: { height: `${height}px` } }, canvas) };
}

/** A compact results table: label, trades, win rate, average and net P&L. */
function statsTable(rows, labelHeading, labelOf) {
  return h(
    'div',
    { class: 'overflow-x-auto' },
    h(
      'table',
      { class: 'stack-table w-full min-w-[420px] tnum text-sm' },
      h(
        'thead',
        { class: 'border-b border-line text-left text-xs uppercase tracking-wide text-muted' },
        h(
          'tr',
          {},
          h('th', { class: 'py-2 pr-3' }, labelHeading),
          h('th', { class: 'py-2 pr-3 text-right' }, 'Trades'),
          h('th', { class: 'py-2 pr-3 text-right' }, 'Win rate'),
          h('th', { class: 'py-2 pr-3 text-right' }, 'Average'),
          h('th', { class: 'py-2 text-right' }, 'Net P&L'),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            { class: 'border-b border-line last:border-0' },
            h('td', { class: 'py-2 pr-3 text-fg' }, labelOf(row)),
            h('td', { class: 'py-2 pr-3 text-right' }, String(row.count)),
            h('td', { class: 'py-2 pr-3 text-right' }, `${row.winRate}%`),
            h(
              'td',
              { class: cn('py-2 pr-3 text-right', tone(row.averagePnl)) },
              signed(row.averagePnl),
            ),
            h(
              'td',
              { class: cn('py-2 text-right font-medium', tone(row.netPnl)) },
              signed(row.netPnl),
            ),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------------------- paint ------------------------------------ */

function paint() {
  const trades = periodTrades(periodSelect.value);
  if (trades.length === 0) {
    render(
      root,
      h(
        'div',
        { class: 'rounded-card border border-line bg-surface p-6' },
        emptyState({
          iconName: 'bar-chart-3',
          title: workspace.trades.length ? 'No trades in this period' : 'No trades yet',
          hint: workspace.trades.length
            ? 'Choose a longer period.'
            : 'Log trades in the Journal or import a broker CSV; insights appear here.',
        }),
      ),
    );
    return;
  }

  const weekdays = weekdayStats(trades);
  const weekdayChart = canvasBox(200);
  const mistakes = tagStats(trades, 'mistakeTags');
  const summary = mistakeSummary(trades);
  const setups = tagStats(trades, 'setupTags').reverse();
  const emotions = emotionStats(trades);
  const r = rStats(trades);
  const rChart = canvasBox(180);
  const curves = strategyCurves(trades, workspace.strategies ?? []);
  const curveChart = canvasBox(260);

  render(
    root,
    h(
      'div',
      { class: 'space-y-6' },
      section(
        'P&L calendar',
        'Net P&L per day for the last three months (colour strength shows size).',
        pnlCalendar(trades),
      ),
      h(
        'div',
        { class: 'grid gap-6 lg:grid-cols-2' },
        section(
          'By weekday',
          'Which days you trade best.',
          weekdayChart.box,
          statsTable(
            weekdays.filter((day) => day.count),
            'Day',
            (row) => row.label,
          ),
        ),
        section(
          'R-multiples',
          r.count
            ? `${r.count} trades with a planned risk${r.missing ? ` · ${r.missing} without` : ''}.`
            : 'Add “Planned risk” in a trade’s review section to measure results in R.',
          r.count
            ? [
                h(
                  'div',
                  { class: 'grid grid-cols-2 gap-3' },
                  statCard({
                    label: 'Average R',
                    value: `${r.averageR}R`,
                    tone: r.averageR >= 0 ? 'positive' : 'negative',
                  }),
                  statCard({
                    label: 'Total R',
                    value: `${r.totalR}R`,
                    tone: r.totalR >= 0 ? 'positive' : 'negative',
                  }),
                  statCard({ label: 'Best', value: `${r.bestR}R` }),
                  statCard({ label: 'Worst', value: `${r.worstR}R` }),
                ),
                rChart.box,
              ]
            : null,
        ),
      ),
      section(
        'Mistakes',
        'Trades tagged with a mistake, costliest first. A trade with two mistakes counts in both rows.',
        h(
          'div',
          { class: 'grid gap-3 sm:grid-cols-2' },
          statCard({
            label: `With mistakes (${summary.withMistakes.count})`,
            value: signed(summary.withMistakes.netPnl),
            tone: summary.withMistakes.netPnl >= 0 ? 'positive' : 'negative',
            hint: `${summary.withMistakes.winRate}% win rate`,
          }),
          statCard({
            label: `Clean trades (${summary.clean.count})`,
            value: signed(summary.clean.netPnl),
            tone: summary.clean.netPnl >= 0 ? 'positive' : 'negative',
            hint: `${summary.clean.winRate}% win rate`,
          }),
        ),
        mistakes.length
          ? statsTable(mistakes, 'Mistake', (row) => row.tag)
          : h(
              'p',
              { class: 'text-sm text-muted' },
              'No mistakes tagged yet. Tag them in a trade’s review section.',
            ),
      ),
      h(
        'div',
        { class: 'grid gap-6 lg:grid-cols-2' },
        section(
          'Setups',
          'Best setups first.',
          setups.length
            ? statsTable(setups, 'Setup', (row) => row.tag)
            : h('p', { class: 'text-sm text-muted' }, 'No setup tags yet.'),
        ),
        section(
          'Emotions',
          'How you felt during the trade.',
          emotions.length
            ? statsTable(emotions, 'Emotion', (row) => emotionLabel(row.emotion))
            : h('p', { class: 'text-sm text-muted' }, 'No emotions recorded yet.'),
        ),
      ),
      section(
        'Strategy equity curves',
        'Cumulative net P&L of each strategy’s trades.',
        curveChart.box,
        statsTable(
          curves.map((curve) => ({ ...curve.stats, name: curve.name })),
          'Strategy',
          (row) => row.name,
        ),
      ),
    ),
  );

  barChart(weekdayChart.canvas, {
    labels: weekdays.map((day) => day.label),
    values: weekdays.map((day) => day.netPnl),
    colors: weekdays.map((day) => (day.netPnl >= 0 ? CHART_POSITIVE : CHART_NEGATIVE)),
    tooltip: (value, context) =>
      `${formatCurrency(Number(value))} · ${weekdays[context.dataIndex].count} trades`,
    xFormatter: (label) => label,
    yFormatter: axisRupees,
  });
  if (r.count) {
    barChart(rChart.canvas, {
      labels: r.buckets.map((bucket) => bucket.label),
      values: r.buckets.map((bucket) => bucket.count),
      colors: r.buckets.map((_, index) => (index < 3 ? CHART_NEGATIVE : CHART_POSITIVE)),
      tooltip: (value) => `${value} trades`,
      integer: true,
      xFormatter: (label) => label,
    });
  }
  // One x axis of every trade date; each strategy holds its last value between its trades.
  const dates = [
    ...new Set(curves.flatMap((curve) => curve.points.map((point) => point.date))),
  ].sort();
  lineChart(curveChart.canvas, {
    labels: dates,
    yFormatter: axisRupees,
    series: curves.slice(0, 6).map((curve) => {
      const byDate = new Map(curve.points.map((point) => [point.date, point.value]));
      let last = null;
      return {
        label: curve.name,
        values: dates.map((date) => (byDate.has(date) ? (last = byDate.get(date)) : last)),
      };
    }),
  });
}

render($('[data-coach]'), createCoachReview({ aiAvailable: Boolean(data.health?.aiAvailable) }));
periodSelect.addEventListener('change', paint);
paint();
