/**
 * Tax report page: the journal summarised for an Indian financial year
 * (speculative intraday equity vs non-speculative F&O, turnover, charges,
 * advance-tax checkpoints and months), with a trade-level CSV download.
 * Calculations: shared/tax-report.js.
 */
import { t } from '../core/i18n.js';
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
  downloadText,
} from '../core/dom.js';
import { todayInIst } from '../../../shared/market.js';
import {
  TAX_CATEGORIES,
  financialYearOf,
  financialYears,
  taxCsv,
  taxReport,
} from '../../../shared/tax-report.js';

const trades = pageData().workspace?.trades ?? [];
const root = $('[data-tax]');
const yearSelect = $('[data-year]');
const csvButton = $('[data-tax-csv]');

const years = [...new Set([financialYearOf(todayInIst()), ...financialYears(trades)])]
  .sort()
  .reverse();
for (const year of years) {
  yearSelect.append(h('option', { value: year }, `FY ${year}`));
}

const money = (value) => formatCurrency(value);
const signed = (value) => `${value >= 0 ? '' : '-'}${formatCurrency(Math.abs(value))}`;
const tone = (value) => (value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : '');
const monthLabel = (key) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleString('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

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

function table(head, rows) {
  return h(
    'div',
    { class: 'overflow-x-auto' },
    h(
      'table',
      { class: 'stack-table w-full min-w-[520px] tnum text-sm' },
      h(
        'thead',
        { class: 'border-b border-line text-left text-xs uppercase tracking-wide text-muted' },
        h(
          'tr',
          {},
          head.map((cell, index) =>
            h('th', { class: cn('py-2 pr-3', index > 0 && 'text-right') }, cell),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            { class: 'border-b border-line last:border-0' },
            row.map((cell, index) =>
              h(
                'td',
                { class: cn('py-2 pr-3', index > 0 && 'text-right', cell?.className) },
                cell?.text ?? cell,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function paint() {
  const report = taxReport(trades, yearSelect.value);
  csvButton.disabled = report.total.trades === 0;
  const { speculative, nonSpeculative } = report.categories;
  const line = (labelText, key, format = money) => [
    labelText,
    ...[speculative, nonSpeculative, report.total].map((totals) =>
      key === 'netPnl' || key === 'grossPnl'
        ? { text: signed(totals[key]), className: tone(totals[key]) }
        : format(totals[key]),
    ),
  ];
  render(
    root,
    h(
      'div',
      { class: 'space-y-6' },
      h(
        'p',
        {
          role: 'note',
          class: 'rounded-card border border-line bg-elevated p-4 text-sm leading-6 text-muted',
        },
        'Not tax advice. Equity trades are treated as intraday (speculative) because the journal records each round trip on one date; report delivery trades held across days as capital gains instead. F&O is non-speculative business income, usually filed in ITR-3. Turnover is the sum of absolute P&L per trade. Confirm figures, tax-audit applicability and set-off rules with your CA.',
      ),
      report.total.trades === 0
        ? h(
            'div',
            { class: 'rounded-card border border-line bg-surface p-6' },
            emptyState({
              iconName: 'file-bar-chart',
              title: `No trades in FY ${report.financialYear}`,
              hint: t('Choose another financial year.'),
            }),
          )
        : [
            section(
              `Summary · FY ${report.financialYear}`,
              `${report.from} to ${report.to}`,
              table(
                ['', 'Speculative', 'Non-speculative (F&O)', 'Total'],
                [
                  line('Trades', 'trades', (value) => String(value)),
                  line('Buy value', 'buyValue'),
                  line('Sell value', 'sellValue'),
                  line('Gross P&L', 'grossPnl'),
                  line('Charges (expenses)', 'charges'),
                  line('Net P&L', 'netPnl'),
                  line('Turnover (absolute P&L)', 'turnover'),
                ],
              ),
              h(
                'ul',
                { class: 'list-disc space-y-1 pl-5 text-xs text-muted' },
                Object.values(TAX_CATEGORIES).map((category) =>
                  h('li', {}, `${category.label}: ${category.note}`),
                ),
              ),
            ),
            section(
              'Advance tax checkpoints',
              'Net P&L earned up to each due date. Pay the shown share of the year’s estimated tax by then.',
              table(
                ['Due date', 'Share of tax due', 'Net P&L so far'],
                report.advanceTax.map((point) => [
                  point.due,
                  `${point.share}%`,
                  { text: signed(point.cumulativeNetPnl), className: tone(point.cumulativeNetPnl) },
                ]),
              ),
            ),
            section(
              'By month',
              null,
              table(
                ['Month', 'Trades', 'Charges', 'Net P&L'],
                report.months
                  .filter((month) => month.trades > 0)
                  .map((month) => [
                    monthLabel(month.key),
                    String(month.trades),
                    money(month.charges),
                    { text: signed(month.netPnl), className: tone(month.netPnl) },
                  ]),
              ),
            ),
          ],
    ),
  );
}

csvButton.addEventListener('click', () => {
  downloadText(
    `tax-report-FY${yearSelect.value}.csv`,
    taxCsv(trades, yearSelect.value),
    'text/csv;charset=utf-8;',
  );
});
yearSelect.addEventListener('change', paint);
paint();
