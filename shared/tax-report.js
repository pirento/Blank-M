/**
 * Tax summary of the journal for an Indian financial year (April–March).
 *
 * Classification used (common practice for traders; not tax advice):
 * - Equity trades are round trips recorded on one date, so they are treated
 *   as intraday: speculative business income.
 * - Futures and options: non-speculative business income.
 * Turnover is the sum of the absolute P&L of each trade (the method used for
 * the tax-audit turnover of F&O and intraday trading). Charges are shown as
 * expenses. Advance-tax figures are the cumulative net P&L up to each due date.
 */

const round2 = (value) => Math.round(value * 100) / 100;

/** Financial year label of an IST date: 2026-10-05 → '2026-27'. */
export function financialYearOf(date) {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** First and last date of a financial year label. */
export function financialYearRange(label) {
  const start = Number(label.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** Financial years that have trades, newest first. */
export function financialYears(trades) {
  return [...new Set(trades.map((trade) => financialYearOf(trade.date)))].sort().reverse();
}

export const TAX_CATEGORIES = {
  speculative: {
    label: 'Speculative business (intraday equity)',
    note: 'Losses can only be set off against speculative income and carried forward 4 years.',
  },
  nonSpeculative: {
    label: 'Non-speculative business (F&O)',
    note: 'Losses can be set off against other business income (not salary) and carried forward 8 years.',
  },
};

/** Tax bucket of a trade: FUT/OPT are non-speculative; everything else is speculative. */
export const categoryOf = (trade) =>
  trade.segment === 'FUT' || trade.segment === 'OPT' ? 'nonSpeculative' : 'speculative';

function buySell(trade) {
  const entry = trade.entryPrice * trade.quantity;
  const exit = trade.exitPrice * trade.quantity;
  return trade.type === 'Short' ? { buy: exit, sell: entry } : { buy: entry, sell: exit };
}

function totals(trades) {
  return {
    trades: trades.length,
    buyValue: round2(trades.reduce((sum, trade) => sum + buySell(trade).buy, 0)),
    sellValue: round2(trades.reduce((sum, trade) => sum + buySell(trade).sell, 0)),
    grossPnl: round2(trades.reduce((sum, trade) => sum + trade.grossPnl, 0)),
    charges: round2(trades.reduce((sum, trade) => sum + trade.charges, 0)),
    netPnl: round2(trades.reduce((sum, trade) => sum + trade.pnl, 0)),
    turnover: round2(trades.reduce((sum, trade) => sum + Math.abs(trade.grossPnl), 0)),
  };
}

/** Advance-tax due dates of a financial year with the share of tax due by each. */
function advanceTaxDates(label) {
  const start = Number(label.slice(0, 4));
  return [
    { due: `${start}-06-15`, share: 15 },
    { due: `${start}-09-15`, share: 45 },
    { due: `${start}-12-15`, share: 75 },
    { due: `${start + 1}-03-15`, share: 100 },
  ];
}

/**
 * The tax summary for one financial year: per-category totals, the overall
 * total, cumulative net P&L at each advance-tax date and per-month net P&L.
 */
export function taxReport(trades, label) {
  const { from, to } = financialYearRange(label);
  const inYear = trades.filter((trade) => trade.date >= from && trade.date <= to);
  const byCategory = Object.fromEntries(
    Object.keys(TAX_CATEGORIES).map((key) => [
      key,
      totals(inYear.filter((trade) => categoryOf(trade) === key)),
    ]),
  );
  const months = [];
  for (let index = 0; index < 12; index += 1) {
    const year = Number(label.slice(0, 4)) + (index >= 9 ? 1 : 0);
    const month = String(((index + 3) % 12) + 1).padStart(2, '0');
    const key = `${year}-${month}`;
    months.push({ key, ...totals(inYear.filter((trade) => trade.date.startsWith(key))) });
  }
  return {
    financialYear: label,
    from,
    to,
    categories: byCategory,
    total: totals(inYear),
    advanceTax: advanceTaxDates(label).map((point) => ({
      ...point,
      cumulativeNetPnl: round2(
        inYear
          .filter((trade) => trade.date <= point.due)
          .reduce((sum, trade) => sum + trade.pnl, 0),
      ),
    })),
    months,
  };
}

const csvCell = (value) => {
  const text = String(value ?? '');
  // Formula-neutral like the trade export: spreadsheets never run cell text.
  const safe = /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Trade-level CSV for one financial year (for a CA or ITR working). */
export function taxCsv(trades, label) {
  const { from, to } = financialYearRange(label);
  const header = [
    'Financial year',
    'Category',
    'Date',
    'Symbol',
    'Segment',
    'Direction',
    'Quantity',
    'Buy value',
    'Sell value',
    'Gross P&L',
    'Charges',
    'Net P&L',
    'Turnover (absolute P&L)',
  ];
  const rows = trades
    .filter((trade) => trade.date >= from && trade.date <= to)
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((trade) => {
      const { buy, sell } = buySell(trade);
      return [
        label,
        categoryOf(trade) === 'speculative' ? 'Speculative' : 'Non-speculative',
        trade.date,
        trade.symbol,
        trade.segment ?? 'EQ',
        trade.type,
        trade.quantity,
        round2(buy).toFixed(2),
        round2(sell).toFixed(2),
        trade.grossPnl.toFixed(2),
        trade.charges.toFixed(2),
        trade.pnl.toFixed(2),
        Math.abs(trade.grossPnl).toFixed(2),
      ];
    });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
