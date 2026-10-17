/**
 * Trading record: date-range picker, headline stats and P&L charts.
 */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  icon,
  cn,
  formatCurrency,
  buttonClass,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  emptyState,
  render,
} from '../../core/dom.js';
import {
  RANGE_LABELS,
  bestAndWorst,
  buildDrawdownCurve,
  buildEquityCurve,
  filterByRange,
  maxDrawdown,
  periodOpeningBalance,
  pnlBySymbol,
  pnlByWeekday,
  pnlDistribution,
  summarisePerformance,
} from '../../../../shared/pnl.js';
import { CHART_NEGATIVE, CHART_POSITIVE, areaChart, barChart } from '../../components/charts.js';
import { RANGES, portfolioBalance, settings, trades } from './shared.js';

let range = 'all';

function stat(label, value, tone = 'neutral') {
  return h(
    'div',
    {
      class:
        'flex items-center justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0',
    },
    h('span', { class: 'text-muted' }, label),
    h(
      'span',
      {
        class: cn(
          'tnum font-medium',
          tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-fg',
        ),
      },
      value,
    ),
  );
}

function chartCard(title, subtitle, height, className = '') {
  const canvas = h('canvas', { role: 'img', 'aria-label': title });
  const element = card(
    { className },
    cardHeader(
      '',
      h('div', {}, cardTitle(title), h('p', { class: 'mt-1 text-xs text-muted' }, subtitle)),
    ),
    cardContent('', h('div', { class: 'w-full', style: { height: `${height}px` } }, canvas)),
  );
  return { element, canvas };
}

function paintRangePicker() {
  render(
    $('[data-range-picker]'),
    ...RANGES.map((key) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(range === key),
          class: cn(
            'focus-ring rounded-control px-3 py-1.5 text-xs font-medium transition-colors',
            range === key ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          ),
          onclick: () => {
            range = key;
            paintRecord();
          },
        },
        RANGE_LABELS[key],
      ),
    ),
  );
}

/**
 * Renders the performance section for the selected range: ledger totals, equity and
 * drawdown curves, P&L breakdowns and recent trades, or an empty state with no trades.
 */
export function paintRecord() {
  paintRangePicker();
  const ranged = filterByRange(trades, range);
  const summary = summarisePerformance(ranged);
  const periodOpening = periodOpeningBalance(settings.openingBalance, trades, range);
  $('[data-record-summary]').textContent =
    `Journal results, not broker-confirmed executions. Win rate ${summary.winRate.toFixed(1)}% · Profit factor ${summary.profitFactor ?? '—'}`;
  render(
    $('[data-journal-ledger]'),
    ...[
      ['Journal balance', formatCurrency(portfolioBalance), 'Opening balance + all logged net P&L'],
      [
        'Journal net P&L',
        formatCurrency(summary.netPnl),
        `Recorded trades · ${RANGE_LABELS[range]}`,
      ],
      ['Logged trades', String(summary.totalTrades), 'Manual and imported records'],
    ].map(([label, value, hint]) =>
      h(
        'div',
        {},
        h('dt', {}, label),
        h('dd', { class: 'reference-ledger-value' }, value),
        h('dd', { class: 'reference-ledger-hint' }, hint),
      ),
    ),
  );
  const container = $('[data-record]');
  if (ranged.length === 0) {
    render(
      container,
      emptyState({
        title:
          trades.length === 0
            ? 'No trades yet'
            : `No trades in the last ${RANGE_LABELS[range].toLowerCase()}`,
        hint:
          trades.length === 0
            ? 'Log your first trade and the charts fill in.'
            : 'Widen the range to see earlier trades.',
        action:
          trades.length === 0
            ? h(
                'div',
                { class: 'flex flex-wrap justify-center gap-2' },
                h('a', { href: '/journal', class: buttonClass() }, 'Log a trade'),
                h('a', { href: '/import', class: buttonClass('outline') }, 'Import a CSV'),
              )
            : h(
                'button',
                {
                  type: 'button',
                  class: buttonClass('outline'),
                  onclick: () => {
                    range = 'all';
                    paintRecord();
                  },
                },
                'Show all time',
              ),
      }),
    );
    return;
  }
  // Drawdown is period-local, using the period opening as its initial peak.
  const equity = buildEquityCurve(periodOpening, ranged).map((point, index) =>
    index === 0
      ? { ...point, label: range === 'all' ? 'Account opening' : 'Period opening (IST)' }
      : point,
  );
  const drawdown = buildDrawdownCurve(periodOpening, ranged);
  const worstDrawdown = maxDrawdown(periodOpening, ranged);
  const { best, worst } = bestAndWorst(ranged);

  const equityCard = chartCard(
    'Equity curve',
    `IST trade dates · ${range === 'all' ? 'Account opening' : 'Period opening, including earlier net P&L'}: ${formatCurrency(periodOpening)}`,
    280,
    'lg:col-span-2',
  );
  const drawdownCard = chartCard(
    'Period drawdown',
    `Deepest fall from a peak within this period: ${formatCurrency(worstDrawdown)}`,
    280,
  );
  const symbolData = pnlBySymbol(ranged).slice(0, 8);
  const weekdayData = pnlByWeekday(ranged);
  const distribution = pnlDistribution(ranged);
  const symbolCard = chartCard('P&L by symbol', 'Where the money is actually made and lost', 240);
  const weekdayCard = chartCard('P&L by weekday', 'Some days are worse than others', 240);
  const distributionCard = chartCard(
    'Trade size distribution',
    'Whether the losses are many small ones or a few large',
    240,
  );

  const recent = card(
    { className: 'lg:col-span-2' },
    cardHeader(
      '',
      cardTitle(t('Recent trades')),
      h(
        'a',
        {
          href: '/transactions',
          class: 'focus-ring rounded-control text-xs font-medium text-accent',
        },
        'View all',
      ),
    ),
    cardContent(
      'space-y-0',
      ranged.slice(0, 5).map((trade, index, visible) =>
        h(
          'div',
          {
            class: cn(
              'flex items-center justify-between py-3',
              index !== visible.length - 1 && 'border-b border-line',
            ),
          },
          h(
            'div',
            { class: 'flex items-center gap-3' },
            h(
              'div',
              {
                class: cn(
                  'rounded-control border p-2',
                  trade.type === 'Long'
                    ? 'border-positive bg-positive-soft text-positive'
                    : 'border-negative bg-negative-soft text-negative',
                ),
              },
              icon(trade.type === 'Long' ? 'trending-up' : 'trending-down', 14),
            ),
            h(
              'div',
              {},
              h(
                'div',
                { class: 'text-sm font-medium text-fg' },
                trade.symbol,
                h('span', { class: 'ml-1.5 text-xs font-normal text-muted' }, trade.type),
              ),
              h(
                'div',
                { class: 'tnum text-xs text-subtle' },
                `${trade.date} · ${trade.quantity} qty`,
              ),
            ),
          ),
          h(
            'div',
            {
              class: cn(
                'tnum text-sm font-medium',
                trade.pnl >= 0 ? 'text-positive' : 'text-negative',
              ),
            },
            formatCurrency(trade.pnl),
          ),
        ),
      ),
    ),
  );
  const performance = card(
    {},
    cardHeader('', cardTitle(t('Performance'))),
    cardContent(
      'space-y-2 text-sm',
      stat('Gross P&L', formatCurrency(summary.grossPnl)),
      stat('Charges', formatCurrency(summary.charges)),
      stat('Average win', formatCurrency(summary.averageWin)),
      stat('Average loss', formatCurrency(summary.averageLoss)),
      stat('Expectancy / trade', formatCurrency(summary.expectancy)),
      stat('Period max drawdown', formatCurrency(worstDrawdown)),
      best ? stat('Best trade', `${best.symbol} ${formatCurrency(best.pnl)}`, 'positive') : null,
      worst
        ? stat('Worst trade', `${worst.symbol} ${formatCurrency(worst.pnl)}`, 'negative')
        : null,
    ),
  );
  render(
    container,
    h(
      'div',
      { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' },
      equityCard.element,
      drawdownCard.element,
    ),
    h(
      'div',
      { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' },
      symbolCard.element,
      weekdayCard.element,
      distributionCard.element,
    ),
    h(
      'div',
      { class: 'grid grid-cols-1 gap-4 lg:grid-cols-3' },
      recent,
      h('div', { class: 'space-y-4' }, performance),
    ),
  );
  areaChart(equityCard.canvas, {
    labels: equity.map((p) => p.label),
    values: equity.map((p) => p.balance),
    tooltipLabel: 'Balance',
  });
  areaChart(drawdownCard.canvas, {
    labels: drawdown.map((p) => p.label),
    values: drawdown.map((p) => p.drawdown),
    color: CHART_NEGATIVE,
    tooltipLabel: 'Below peak',
    fillOpacity: 0.12,
  });
  const netTooltip = (value) => `Net P&L: ${formatCurrency(Number(value))}`;
  barChart(symbolCard.canvas, {
    labels: symbolData.map((entry) => entry.key),
    values: symbolData.map((entry) => entry.netPnl),
    colors: symbolData.map((entry) => (entry.netPnl >= 0 ? CHART_POSITIVE : CHART_NEGATIVE)),
    tooltip: netTooltip,
    xFormatter: (label) => String(label).slice(0, 4),
  });
  barChart(weekdayCard.canvas, {
    labels: weekdayData.map((entry) => entry.key),
    values: weekdayData.map((entry) => entry.netPnl),
    colors: weekdayData.map((entry) => (entry.netPnl >= 0 ? CHART_POSITIVE : CHART_NEGATIVE)),
    tooltip: netTooltip,
    xFormatter: (label) => String(label).slice(0, 4),
  });
  barChart(distributionCard.canvas, {
    labels: distribution.map((bucket) => bucket.label),
    values: distribution.map((bucket) => bucket.count),
    colors: distribution.map((bucket) =>
      bucket.label.startsWith('Win') ? CHART_POSITIVE : CHART_NEGATIVE,
    ),
    tooltip: (value) => `${Number(value)} trades`,
    showX: false,
    integer: true,
  });
}
