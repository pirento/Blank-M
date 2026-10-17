/**
 * Shared journal page (mentor link): read-only summary, equity curve, P&L
 * calendar, mistakes and setups, and the trade list. Data comes embedded in
 * the page; nothing here can change the member's journal.
 */
import { watchStackTables } from '../core/stack-tables.js';
import { signedCurrency as signed, pnlTone as tone } from '../core/format.js';
import {
  $,
  h,
  cn,
  pageData,
  button,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  emptyState,
  render,
  statCard,
} from '../core/dom.js';
import { buildEquityCurve, summarisePerformance } from '../../../shared/pnl.js';
import { groupStats, tagStats } from '../../../shared/insights.js';
import { segmentLabel } from '../../../shared/segments.js';
import { areaChart } from '../components/charts.js';
import { pnlCalendar } from '../components/pnl-calendar.js';

const { shared } = pageData();
const trades = shared.trades;
const strategyNames = new Map(shared.strategies.map((strategy) => [strategy.id, strategy.name]));
const PAGE = 100;
let shown = PAGE;

function section(title, ...children) {
  return card({}, cardHeader('', cardTitle(title)), cardContent('space-y-4', ...children));
}

function tagTable(rows, heading) {
  return rows.length
    ? h(
        'table',
        { class: 'w-full tnum text-sm' },
        h(
          'thead',
          { class: 'border-b border-line text-left text-xs uppercase tracking-wide text-muted' },
          h(
            'tr',
            {},
            h('th', { class: 'py-2' }, heading),
            h('th', { class: 'py-2 text-right' }, 'Trades'),
            h('th', { class: 'py-2 text-right' }, 'Win rate'),
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
              h('td', { class: 'py-2' }, row.tag),
              h('td', { class: 'py-2 text-right' }, String(row.count)),
              h('td', { class: 'py-2 text-right' }, `${row.winRate}%`),
              h('td', { class: cn('py-2 text-right', tone(row.netPnl)) }, signed(row.netPnl)),
            ),
          ),
        ),
      )
    : h('p', { class: 'text-sm text-muted' }, `No ${heading.toLowerCase()} tags recorded.`);
}

function tradeRows() {
  return trades
    .slice(0, shown)
    .map((trade) =>
      h(
        'tr',
        { class: 'border-b border-line align-top last:border-0' },
        h('td', { class: 'py-2 pr-3 whitespace-nowrap' }, trade.date),
        h(
          'td',
          { class: 'py-2 pr-3' },
          h('span', { class: 'font-medium text-fg' }, trade.symbol),
          h(
            'div',
            { class: 'text-xs text-muted' },
            [
              trade.type,
              trade.segment !== 'EQ' ? segmentLabel(trade.segment) : null,
              trade.strategyId ? strategyNames.get(trade.strategyId) : null,
              ...trade.setupTags,
            ]
              .filter(Boolean)
              .join(' · '),
          ),
          trade.mistakeTags.length
            ? h('div', { class: 'text-xs text-negative' }, trade.mistakeTags.join(' · '))
            : null,
          trade.notes ? h('p', { class: 'mt-1 max-w-md text-xs text-muted' }, trade.notes) : null,
        ),
        h('td', { class: 'py-2 pr-3 text-right' }, trade.quantity.toLocaleString('en-IN')),
        h(
          'td',
          { class: 'py-2 pr-3 text-right whitespace-nowrap' },
          `${trade.entryPrice} → ${trade.exitPrice}`,
        ),
        h('td', { class: cn('py-2 text-right font-medium', tone(trade.pnl)) }, signed(trade.pnl)),
      ),
    );
}

function paint() {
  if (!trades.length) {
    render(
      $('[data-share]'),
      emptyState({ iconName: 'book-open', title: 'No trades yet', hint: '' }),
    );
    return;
  }
  const summary = summarisePerformance(trades);
  const curve = buildEquityCurve(0, trades);
  const canvas = h('canvas');
  const mistakes = groupStats(trades.filter((trade) => trade.mistakeTags.length));
  render(
    $('[data-share]'),
    h(
      'div',
      { class: 'grid gap-3 sm:grid-cols-4' },
      statCard({
        label: 'Net P&L',
        value: signed(summary.netPnl),
        tone: summary.netPnl >= 0 ? 'positive' : 'negative',
      }),
      statCard({ label: 'Trades', value: String(summary.totalTrades) }),
      statCard({ label: 'Win rate', value: `${summary.winRate.toFixed(1)}%` }),
      statCard({
        label: 'Profit factor',
        value: summary.profitFactor === null ? '—' : String(summary.profitFactor),
      }),
    ),
    section(
      'Cumulative net P&L',
      h('div', { class: 'w-full', style: { height: '220px' } }, canvas),
    ),
    section('P&L calendar', pnlCalendar(trades)),
    h(
      'div',
      { class: 'grid gap-6 lg:grid-cols-2' },
      section(
        'Mistakes',
        h(
          'p',
          { class: 'text-sm text-muted' },
          `${mistakes.count} trades tagged with a mistake: ${signed(mistakes.netPnl)} net.`,
        ),
        tagTable(tagStats(trades, 'mistakeTags'), 'Mistake'),
      ),
      section('Setups', tagTable(tagStats(trades, 'setupTags').reverse(), 'Setup')),
    ),
    section(
      `Trades (${trades.length})`,
      h(
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
              h('th', { class: 'py-2 pr-3' }, 'Date'),
              h('th', { class: 'py-2 pr-3' }, 'Trade'),
              h('th', { class: 'py-2 pr-3 text-right' }, 'Qty'),
              h('th', { class: 'py-2 pr-3 text-right' }, 'Entry → exit'),
              h('th', { class: 'py-2 text-right' }, 'Net P&L'),
            ),
          ),
          h('tbody', {}, tradeRows()),
        ),
      ),
      trades.length > shown
        ? button(`Show ${Math.min(PAGE, trades.length - shown)} more`, {
            variant: 'outline',
            onclick: () => {
              shown += PAGE;
              paint();
            },
          })
        : null,
    ),
  );
  areaChart(canvas, {
    labels: curve.map((point) => point.label),
    values: curve.map((point) => point.balance),
    tooltipLabel: 'Cumulative net',
  });
}

paint();

watchStackTables();
