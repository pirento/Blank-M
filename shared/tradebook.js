/**
 * Broker tradebook exports (one row per fill) → journal round trips.
 *
 * Zerodha, Upstox, Angel One, Dhan and most Indian brokers export a
 * tradebook: date, symbol, buy/sell, quantity and a single price per fill.
 * The import page expects one row per round trip, so a recognised tradebook
 * is converted first: fills are grouped by day and symbol and paired from flat
 * to flat (shared/broker-fills.js). Positions still open at the end of a day
 * (delivery holdings, carried F&O) are reported instead of imported.
 */
import { fillsToRoundTrips } from './broker-fills.js';
import { normaliseDate, normaliseDirection, normaliseNumber } from './csv.js';

const squash = (header) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

const TRADEBOOK_ALIASES = {
  date: ['tradedate', 'date', 'orderdate', 'tradingdate', 'executiondate', 'trddate'],
  time: ['ordertime', 'tradetime', 'orderexecutiontime', 'executiontime', 'time', 'exchangetime'],
  symbol: [
    'symbol',
    'tradingsymbol',
    'scrip',
    'scripname',
    'company',
    'name',
    'instrument',
    'stock',
  ],
  side: ['tradetype', 'side', 'buysell', 'transactiontype', 'type', 'action', 'bs'],
  quantity: ['quantity', 'qty', 'tradedquantity', 'tradedqty', 'filledqty', 'tradeqty'],
  price: [
    'price',
    'tradeprice',
    'rate',
    'tradedprice',
    'avgprice',
    'averageprice',
    'netrate',
    'tradedrate',
  ],
  tradeId: ['tradeid', 'tradeno', 'tradenumber', 'tradenum', 'exchangetradeid'],
  exchange: ['exchange', 'exch'],
  segment: ['segment', 'exchangesegment', 'instrumenttype'],
};

/** Columns that mean the file already has one row per round trip. */
const ROUND_TRIP_HINTS = ['entry', 'exit', 'buyprice', 'sellprice', 'buyavg', 'sellavg'];

/** HH:MM:SS from a time or timestamp cell, '00:00:00' when there is none. */
function timeOf(value) {
  const match = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return '00:00:00';
  return [match[1], match[2], match[3] ?? '00'].map((part) => part.padStart(2, '0')).join(':');
}

function find(squashed, aliases, taken) {
  let index = squashed.findIndex((header, i) => !taken.has(i) && aliases.includes(header));
  if (index === -1) {
    index = squashed.findIndex(
      (header, i) =>
        !taken.has(i) && aliases.some((alias) => alias.length > 4 && header.includes(alias)),
    );
  }
  if (index !== -1) taken.add(index);
  return index;
}

/**
 * Column positions when `headers` look like a fill-per-row tradebook, else
 * null. Needs date, symbol, side, quantity and one price column, and no
 * entry/exit or buy/sell price pair.
 */
export function detectTradebook(headers) {
  const squashed = headers.map(squash);
  if (squashed.some((header) => ROUND_TRIP_HINTS.some((hint) => header.includes(hint))))
    return null;
  const taken = new Set();
  const columns = {};
  // Trade IDs first, so "Trade No" is not mistaken for anything else.
  for (const field of [
    'tradeId',
    'time',
    'date',
    'symbol',
    'side',
    'quantity',
    'price',
    'exchange',
    'segment',
  ]) {
    columns[field] = find(squashed, TRADEBOOK_ALIASES[field], taken);
  }
  const required = ['date', 'symbol', 'side', 'quantity', 'price'];
  return required.every((field) => columns[field] !== -1) ? columns : null;
}

/** Cash-equity exchange of a row, or null for derivatives/other segments. */
function equityExchange(row, columns) {
  const exchange =
    columns.exchange === -1 ? 'NSE' : String(row[columns.exchange] ?? '').toUpperCase();
  const segment = columns.segment === -1 ? '' : String(row[columns.segment] ?? '').toUpperCase();
  if (/FO|FUT|OPT|CDS|COM|MCX|NFO|BFO|CURRENCY|DERIV/.test(`${exchange} ${segment}`)) return null;
  if (exchange.includes('BSE')) return 'BSE';
  return 'NSE';
}

/**
 * Converts tradebook rows to round-trip rows with the headers the import page
 * already maps: Date, Symbol, Type, Entry, Exit, Qty, Notes.
 * @returns {{ headers: string[], rows: string[][], fills: number, open: object[], skipped: object[] }}
 */
export function tradebookToRoundTrips(headers, rows) {
  const columns = detectTradebook(headers);
  if (!columns) throw new Error('Not a tradebook.');
  const fills = [];
  const skipped = [];
  rows.forEach((row, index) => {
    if (row.every((value) => String(value).trim() === '')) return;
    const line = index + 2;
    const date = normaliseDate(String(row[columns.date] ?? ''));
    const side = normaliseDirection(String(row[columns.side] ?? ''));
    const quantity = normaliseNumber(String(row[columns.quantity] ?? ''));
    const price = normaliseNumber(String(row[columns.price] ?? ''));
    const symbol = String(row[columns.symbol] ?? '')
      .trim()
      .toUpperCase()
      .replace(/-EQ$/, '');
    const exchange = equityExchange(row, columns);
    if (!exchange) {
      skipped.push({
        line,
        symbol,
        reason:
          'Derivative or non-equity fill (import F&O trades from the journal form or Zerodha fills).',
      });
      return;
    }
    if (
      !date ||
      !side ||
      !symbol ||
      !(quantity > 0) ||
      !(price > 0) ||
      !Number.isInteger(quantity)
    ) {
      skipped.push({ line, symbol, reason: 'Could not read the date, side, quantity or price.' });
      return;
    }
    // Some brokers put the time inside the date cell instead of its own column.
    const time = String(row[columns.time === -1 ? columns.date : columns.time] ?? '');
    fills.push({
      // Fills pair within one day: a journal trade is a same-day round trip.
      symbol,
      exchange,
      product: date,
      side: side === 'Long' ? 'BUY' : 'SELL',
      quantity,
      averagePrice: price,
      tradeId:
        String(columns.tradeId === -1 ? '' : (row[columns.tradeId] ?? '')).trim() ||
        `L${String(line).padStart(7, '0')}`,
      // Time order within the day; file order when the time is missing.
      filledAt: `${date}T${timeOf(time)}#${String(line).padStart(7, '0')}`,
    });
  });
  const { trips, open } = fillsToRoundTrips(fills);
  return {
    headers: ['Date', 'Symbol', 'Type', 'Entry', 'Exit', 'Qty', 'Notes'],
    rows: trips.map((trip) => [
      trip.product,
      trip.symbol,
      trip.type,
      String(trip.entryPrice),
      String(trip.exitPrice),
      String(trip.quantity),
      `From tradebook (${trip.exchange}, ${trip.fillIds.length} fills)`,
    ]),
    fills: fills.length,
    open: open.map((item) => ({
      date: item.product,
      symbol: item.symbol,
      quantity: item.quantity,
    })),
    skipped,
  };
}
