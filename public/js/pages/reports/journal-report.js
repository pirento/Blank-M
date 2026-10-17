/**
 * Journal performance report: the printable report, AI insights and PDF export.
 */
import {
  $,
  h,
  icon,
  cn,
  button,
  card,
  cardHeader,
  cardContent,
  formatCurrency,
  render,
} from '../../core/dom.js';
import { notify, notifyError } from '../../core/toast.js';
import {
  inReportPeriod,
  instantBusinessDate,
  reportPeriodTitle,
  reportPdfFilename,
} from '../../../../shared/business-dates.js';
import { summarisePerformance } from '../../../../shared/pnl.js';
import { todayInIst } from '../../../../shared/market.js';
import { requestInsights } from '../../lib/ai.js';
import { exportElementToPdf } from '../../lib/pdf.js';
import { aiGate } from '../../components/ai-gate.js';
import { markdown } from '../../components/markdown.js';
import {
  currentPeriod,
  generatorCard,
  journal,
  section,
  stat,
  todayStocks,
} from './journal-generator.js';
import { accountId, data, workspace, workspaceAvailable } from './shared.js';

let insightRequest = null;
let pdfRequest = null;

function reportView() {
  const period = currentPeriod();
  const { trades, strategies, watchlist, chatMessages, rules } = workspace;
  const reportTrades = trades.filter((trade) => inReportPeriod(trade.date, period));
  const chat = chatMessages.filter((message) =>
    inReportPeriod(instantBusinessDate(message.timestamp), period),
  );
  const title = reportPeriodTitle(period);
  const isToday = period.type === 'daily' && period.key === todayInIst();
  const summary = summarisePerformance(reportTrades);
  // Section numbers are derived, so a hidden section cannot leave a gap.
  const names = ['Summary', 'Transactions'];
  if (isToday) names.push('Picked Stocks (Today)');
  names.push('Watchlist Snapshot', 'Strategies Snapshot', 'AI Chat Insights');
  const n = Object.fromEntries(names.map((name, index) => [name, index + 1]));
  const picks = isToday ? todayStocks() : [];

  const payload = JSON.stringify(
    {
      period: title,
      periodRange: {
        type: period.type,
        start: period.start,
        end: period.end,
        endInclusive: true,
        timeZone: 'Asia/Kolkata',
        convention:
          period.type === 'weekly'
            ? 'Monday–Sunday calendar week; not market-open sessions'
            : 'IST calendar dates',
      },
      scope: {
        journal: 'Currently loaded journal records only; complete history is not guaranteed.',
        strategies: 'Current snapshot, not historical state for the selected period.',
        rules: 'Current snapshot, not historical state for the selected period.',
      },
      summary,
      trades: reportTrades,
      strategies,
      rules,
    },
    null,
    2,
  );
  const identity = JSON.stringify([accountId, journal.generation, period, payload]);
  const insights = journal.insightsFor === identity ? journal.insights : null;

  const aiButton = button(
    [
      icon(
        journal.generatingInsights ? 'loader-2' : 'bot',
        16,
        journal.generatingInsights ? 'mr-2 animate-spin' : 'mr-2',
      ),
      'AI analysis',
    ],
    {
      variant: 'primary',
      disabled: journal.generatingInsights,
      onclick: async () => {
        insightRequest?.abort();
        const controller = new AbortController();
        insightRequest = controller;
        journal.generatingInsights = true;
        paintJournal();
        try {
          const text = await requestInsights(payload, controller.signal);
          if (insightRequest !== controller) return;
          journal.insights = text;
          journal.insightsFor = identity;
        } catch (error) {
          if (insightRequest === controller && !controller.signal.aborted)
            notifyError(error, 'Could not generate insights.');
        } finally {
          if (insightRequest === controller) {
            insightRequest = null;
            journal.generatingInsights = false;
            paintJournal();
          }
        }
      },
    },
  );

  const printable = h(
    'div',
    {
      class:
        'printable-report relative overflow-hidden rounded-card border border-line bg-surface p-8',
    },
    insights
      ? card(
          { className: 'mb-8 border-accent bg-accent-soft' },
          cardHeader(
            '',
            h(
              'h3',
              { class: 'flex items-center gap-2 text-base font-normal text-accent' },
              icon('bot', 20),
              'AI Insights',
            ),
          ),
          cardContent('max-w-none text-sm text-fg', markdown(insights)),
        )
      : null,
    h(
      'div',
      { class: 'mb-8 border-b border-line pb-6 text-center' },
      h('h1', { class: 'text-3xl text-fg sm:text-4xl' }, 'Trading Performance Report'),
      reportTrades.length > 0
        ? h(
            'p',
            {
              class: `mx-auto mt-4 w-fit rounded-full border px-4 py-1 text-sm font-semibold ${summary.netPnl > 0 ? 'border-positive text-positive' : summary.netPnl < 0 ? 'border-negative text-negative' : 'border-line text-muted'}`,
            },
            summary.netPnl > 0 ? 'PROFIT' : summary.netPnl < 0 ? 'LOSS' : 'BREAK-EVEN',
          )
        : null,
      h('p', { class: 'mt-2 tnum text-sm text-muted' }, `${title} · IST business dates`),
      h(
        'p',
        { class: 'mt-2 tnum text-sm text-muted' },
        `Inclusive range: ${period.start} to ${period.end} · IST (UTC+05:30)`,
      ),
      period.type === 'weekly'
        ? h(
            'p',
            { class: 'mt-2 text-sm text-muted' },
            'Monday–Sunday calendar week. This reporting convention includes weekends and does not identify market-open sessions.',
          )
        : null,
      h(
        'p',
        { class: 'mt-4 text-sm text-muted' },
        'Summary and transactions cover currently loaded journal records only; complete history is not guaranteed. Journal records do not verify broker execution. Chat is filtered from a recent loaded window of up to 200 messages and may omit older conversations. Watchlist, strategies and rules are current snapshots, not historical state for this period.',
      ),
    ),
    h(
      'div',
      { class: 'space-y-8 text-fg' },
      section(
        n.Summary,
        'Summary',
        h(
          'div',
          { class: 'grid grid-cols-2 gap-4 lg:grid-cols-4' },
          stat('Trades', String(summary.totalTrades)),
          stat('Win rate', `${summary.winRate.toFixed(1)}%`),
          stat('Charges', formatCurrency(summary.charges)),
          stat(
            'Net P&L',
            `${summary.netPnl >= 0 ? '+' : ''}${formatCurrency(summary.netPnl)}`,
            summary.netPnl >= 0 ? 'positive' : 'negative',
          ),
        ),
      ),
      section(
        n.Transactions,
        'Transactions',
        reportTrades.length === 0
          ? h(
              'p',
              { class: 'tnum text-sm text-muted' },
              'No trades in the currently loaded journal records for this period.',
            )
          : h(
              'div',
              { class: 'space-y-2' },
              reportTrades.map((trade) =>
                h(
                  'div',
                  { class: 'flex flex-wrap items-center justify-between gap-2 bg-elevated p-3' },
                  h(
                    'div',
                    {},
                    h('span', { class: 'font-bold' }, trade.symbol),
                    h('span', { class: 'ml-2 text-xs text-muted' }, `(${trade.type})`),
                    h('span', { class: 'ml-2 tnum text-xs text-muted' }, trade.date),
                  ),
                  h(
                    'div',
                    { class: 'tnum text-xs' },
                    `Entry ${trade.entryPrice} | Exit ${trade.exitPrice} | Qty ${trade.quantity} | Fees ${formatCurrency(trade.charges)}`,
                  ),
                  h(
                    'div',
                    { class: `font-bold ${trade.pnl >= 0 ? 'text-positive' : 'text-negative'}` },
                    `${trade.pnl >= 0 ? '+' : ''}${formatCurrency(trade.pnl)}`,
                  ),
                ),
              ),
            ),
      ),
      isToday
        ? section(
            n['Picked Stocks (Today)'],
            'Picked Stocks (Today)',
            picks.length === 0
              ? h('p', { class: 'tnum text-sm text-muted' }, 'No stocks picked today.')
              : h(
                  'div',
                  { class: 'space-y-4' },
                  picks.map((stock) =>
                    h(
                      'div',
                      { class: 'bg-elevated p-3' },
                      h('div', { class: 'mb-1 font-bold text-accent' }, stock.symbol),
                      h('p', { class: 'text-sm' }, stock.reason),
                    ),
                  ),
                ),
          )
        : null,
      section(
        n['Watchlist Snapshot'],
        'Watchlist Snapshot',
        watchlist.length === 0
          ? h('p', { class: 'tnum text-sm text-muted' }, 'Empty watchlist.')
          : h(
              'div',
              { class: 'flex flex-wrap gap-2' },
              watchlist.map((item) =>
                h(
                  'span',
                  { class: 'rounded-full bg-elevated px-3 py-1 tnum text-sm font-bold uppercase' },
                  item.symbol,
                ),
              ),
            ),
      ),
      section(
        n['Strategies Snapshot'],
        'Strategies Snapshot',
        strategies.length === 0
          ? h('p', { class: 'tnum text-sm text-muted' }, 'No strategies logged.')
          : h(
              'div',
              { class: 'space-y-4' },
              strategies.map((strategy) =>
                h(
                  'div',
                  { class: 'bg-elevated p-3' },
                  h('h4', { class: 'mb-1 font-bold' }, strategy.name),
                  h('p', { class: 'tnum text-xs whitespace-pre-wrap text-muted' }, strategy.rules),
                ),
              ),
            ),
      ),
      section(
        n['AI Chat Insights'],
        'AI Chat Insights',
        chat.length === 0
          ? h(
              'p',
              { class: 'tnum text-sm text-muted' },
              'No matching conversations in the recent loaded chat window.',
            )
          : h(
              'div',
              { class: 'space-y-4' },
              chat.map((message) =>
                h(
                  'div',
                  {
                    class: cn(
                      'p-3',
                      message.role === 'user'
                        ? 'ml-8 border border-accent bg-accent text-white'
                        : 'mr-8 border border-line bg-elevated text-fg',
                    ),
                  },
                  h(
                    'div',
                    { class: 'mb-1 text-xs text-muted' },
                    message.role === 'user' ? 'You' : 'AI Assistant',
                  ),
                  h('div', { class: 'max-w-none text-sm leading-relaxed' }, markdown(message.text)),
                ),
              ),
            ),
      ),
    ),
  );

  const pdfButton = button(
    [
      icon(
        journal.generatingPdf ? 'loader-2' : 'file-down',
        16,
        journal.generatingPdf ? 'mr-2 animate-spin' : 'mr-2',
      ),
      journal.generatingPdf ? 'Processing…' : 'Download PDF',
    ],
    {
      variant: 'outline',
      disabled: journal.generatingPdf,
      onclick: async () => {
        if (pdfRequest && !pdfRequest.signal.aborted) return;
        const controller = new AbortController();
        pdfRequest = controller;
        const generation = journal.generation;
        journal.generatingPdf = true;
        render(pdfButton, icon('loader-2', 16, 'mr-2 animate-spin'), 'Processing…');
        pdfButton.disabled = true;
        const accepted = () =>
          pdfRequest === controller && journal.generation === generation && printable.isConnected;
        try {
          await exportElementToPdf(
            printable,
            reportPdfFilename(period),
            controller.signal,
            accepted,
          );
          if (accepted()) notify('PDF downloaded.', 'success');
        } catch (error) {
          if (accepted()) notifyError(error, 'Could not generate the PDF.');
        } finally {
          if (pdfRequest === controller) {
            pdfRequest = null;
            journal.generatingPdf = false;
            render(pdfButton, icon('file-down', 16, 'mr-2'), 'Download PDF');
            pdfButton.disabled = false;
          }
        }
      },
    },
  );

  return h(
    'div',
    { class: 'mx-auto max-w-4xl space-y-6' },
    h(
      'div',
      { class: 'hide-on-print flex flex-wrap justify-end gap-4' },
      aiGate(data.health, 'AI analysis', aiButton),
      button([icon('printer', 16, 'mr-2'), 'Print'], {
        variant: 'outline',
        onclick: () => window.print(),
      }),
      pdfButton,
    ),
    printable,
  );
}

/** Renders the journal reports section: the generated report when ready, otherwise the generator card. */
export function paintJournal() {
  const notice = !accountId
    ? 'Reports are unavailable until your active account is ready.'
    : !workspace
      ? 'Reports are unavailable because your journal data could not be loaded. Check your connection and reload.'
      : null;
  const showReport = journal.generated && workspaceAvailable && currentPeriod() !== null;
  render(
    $('[data-journal]'),
    h(
      'div',
      { class: 'space-y-6 py-6' },
      h(
        'div',
        {
          class:
            'mb-8 flex flex-col justify-between gap-4 border-b border-line pb-4 md:flex-row md:items-center',
        },
        h('h2', { class: 'text-xl font-semibold tracking-tight text-fg' }, 'Journal reports'),
        journal.generated
          ? button('New report', {
              variant: 'outline',
              onclick: () => {
                insightRequest?.abort();
                insightRequest = null;
                pdfRequest?.abort();
                pdfRequest = null;
                Object.assign(journal, {
                  generated: false,
                  periodError: null,
                  generatingInsights: false,
                  generatingPdf: false,
                });
                paintJournal();
              },
            })
          : null,
      ),
      notice ? h('p', { role: 'alert', class: 'text-sm text-muted' }, notice) : null,
      showReport ? reportView() : generatorCard(),
    ),
  );
}
