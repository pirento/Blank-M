/**
 * Journal report generator: period picker, today's research picks and the
 * small layout helpers the report view uses.
 */
import {
  h,
  icon,
  button,
  input,
  label,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { reportPeriod } from '../../../../shared/business-dates.js';
import { todayInIst } from '../../../../shared/market.js';
import { readResearchArchive } from '../../lib/research-store.js';
import { paintJournal } from './journal-report.js';
import { accountId, workspaceAvailable } from './shared.js';

export const journal = {
  generated: false,
  reportType: 'daily',
  selectedDate: todayInIst(),
  selectedMonth: todayInIst().slice(0, 7),
  periodError: null,
  generation: 0,
  insights: null,
  insightsFor: null,
  generatingInsights: false,
  generatingPdf: false,
};

/** The report period for the selected type and date/month, or null when the input is invalid. */
export const currentPeriod = () =>
  reportPeriod(
    journal.reportType,
    journal.reportType === 'monthly' ? journal.selectedMonth : journal.selectedDate,
  );

/** Picks from today's latest completed research run in this browser, if any. */
export function todayStocks() {
  if (!accountId) return [];
  const today = todayInIst();
  const run = readResearchArchive(accountId).runs.find(
    (entry) => entry.outcome === 'completed' && entry.inputs.businessDate === today,
  );
  return run?.picks ?? [];
}

/** Builds a numbered report section with a heading. */
export function section(number, title, ...children) {
  return h(
    'section',
    {},
    h(
      'h3',
      { class: 'mb-4 border-b border-line pb-2 text-base font-semibold tracking-tight text-fg' },
      `${number}. ${title}`,
    ),
    ...children,
  );
}

/** Builds a centred stat tile; `tone` (`positive`/`negative`) colours the value. */
export function stat(labelText, value, tone) {
  const toneClass =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : '';
  return h(
    'div',
    { class: 'rounded-card bg-elevated p-4 text-center' },
    h('div', { class: 'text-xs text-muted' }, labelText),
    h('div', { class: `tnum mt-1.5 text-2xl font-semibold tracking-tight ${toneClass}` }, value),
  );
}

/**
 * Builds the "Generate Report" card: report type buttons, date or month picker with IST
 * range help, and a Generate button that validates the period and shows the report.
 */
export function generatorCard() {
  const help = h('div', { id: 'report-period-help', class: 'space-y-2 text-sm text-muted' });
  const errorSlot = h('div', { id: 'report-period-error' });
  const periodInput =
    journal.reportType !== 'monthly'
      ? input({
          id: 'report-period',
          type: 'date',
          min: '0001-01-01',
          max: '9999-12-31',
          value: journal.selectedDate,
          'aria-describedby': 'report-period-help report-period-error',
          invalid: Boolean(journal.periodError),
        })
      : input({
          id: 'report-period',
          type: 'month',
          min: '0001-01',
          max: '9999-12',
          value: journal.selectedMonth,
          'aria-describedby': 'report-period-help report-period-error',
          invalid: Boolean(journal.periodError),
        });
  const paintHelp = () => {
    const period = currentPeriod();
    render(
      help,
      journal.reportType === 'weekly'
        ? h(
            'p',
            {},
            'Monday–Sunday calendar week in IST (UTC+05:30). This is a reporting convention, not market-open-session logic. Only complete weeks within years 0001–9999 are supported.',
          )
        : null,
      period
        ? h('p', {}, `Inclusive range: ${period.start} to ${period.end} · IST (UTC+05:30)`)
        : null,
    );
    render(
      errorSlot,
      journal.periodError
        ? h('p', { role: 'alert', class: 'mt-1 text-xs text-negative' }, journal.periodError)
        : null,
    );
  };
  periodInput.addEventListener('input', () => {
    if (journal.reportType === 'monthly') journal.selectedMonth = periodInput.value;
    else journal.selectedDate = periodInput.value;
    journal.periodError = null;
    paintHelp();
  });
  paintHelp();
  return card(
    { className: 'mx-auto max-w-md' },
    cardHeader('', cardTitle('Generate Report')),
    cardContent(
      'space-y-6',
      h(
        'div',
        { class: 'space-y-2' },
        h('span', { class: 'mb-1.5 block text-xs font-medium text-muted' }, 'Report type'),
        h(
          'div',
          { class: 'flex gap-2', role: 'group', 'aria-label': 'Report type' },
          ['daily', 'weekly', 'monthly'].map((type) =>
            button(type.charAt(0).toUpperCase() + type.slice(1), {
              variant: journal.reportType === type ? 'default' : 'outline',
              'aria-pressed': String(journal.reportType === type),
              className: 'flex-1',
              onclick: () => {
                journal.reportType = type;
                journal.periodError = null;
                paintJournal();
              },
            }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'space-y-2' },
        label(
          journal.reportType === 'monthly'
            ? 'Select month'
            : journal.reportType === 'weekly'
              ? 'Select a date in the week'
              : 'Select date',
          'report-period',
        ),
        h(
          'div',
          { class: 'flex items-center gap-2' },
          icon('calendar', 18, 'text-muted'),
          periodInput,
        ),
      ),
      help,
      errorSlot,
      button('Generate', {
        className: 'w-full',
        disabled: !workspaceAvailable,
        onclick: () => {
          if (!workspaceAvailable) return;
          if (!currentPeriod()) {
            journal.periodError =
              journal.reportType === 'weekly'
                ? 'Enter a valid date whose complete Monday–Sunday week falls within years 0001–9999.'
                : `Enter a valid ${journal.reportType === 'daily' ? 'date' : 'month'} (years 0001–9999).`;
            paintHelp();
            return;
          }
          journal.periodError = null;
          journal.generation += 1;
          journal.generated = true;
          journal.insights = null;
          paintJournal();
        },
      }),
    ),
  );
}
