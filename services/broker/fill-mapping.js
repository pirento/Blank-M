/**
 * Turns broker trade-book, position and holding rows into the journal's fill
 * shape (shared/broker-fills.js) and carried-in map, for the brokers whose
 * rows differ only in field names (Upstox, Fyers, Angel One). Symbols become
 * the journal's: NSE/BSE equity without its "-EQ" series or "NSE:" prefix, and
 * F&O as Kite-style contract names. A row that cannot be read reliably is
 * listed as skipped with a reason, never guessed.
 */
import { contractSymbol } from './dhan.js';
import { brokerTradingDate } from './portfolio.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH = MONTHS.join('|');
const pad = (value) => String(value).padStart(2, '0');

/** Equity symbol as the journal stores it: upper case, no exchange prefix, no -EQ series. */
export function equitySymbol(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/^(NSE|BSE):/, '')
    .replace(/-EQ$/, '');
}

/** Already a Kite-style contract: NIFTY26OCTFUT, NIFTY26OCT25000CE or weekly NIFTY2610625000CE. */
const KITE_CONTRACT = new RegExp(
  `^[A-Z0-9&-]+?\\d{2}(?:(?:${MONTH})(?:FUT|\\d+(?:\\.\\d+)?(?:CE|PE))|[1-9OND]\\d{2}\\d+(?:\\.\\d+)?(?:CE|PE))$`,
);
/** Contract with its full expiry date, DDMMMYY: NIFTY27OCT2625000CE, NIFTY27OCT26FUT (Angel One). */
const DATED_CONTRACT = new RegExp(
  `^([A-Z0-9&-]+?)(\\d{2})(${MONTH})(\\d{2})(?:FUT|(\\d+(?:\\.\\d+)?)(CE|PE))$`,
);
/** Spaced contract with its expiry: "NIFTY 25000 CE 27 OCT 26", "NIFTY FUT 27 OCT 26" (Upstox). */
const SPACED_CONTRACT = new RegExp(
  `^([A-Z0-9&-]+) (?:FUT|(\\d+(?:\\.\\d+)?) (CE|PE)) (\\d{2}) (${MONTH}) (\\d{2})$`,
);

function fromParts(base, day, month, yy, strike, kind) {
  const monthIndex = MONTHS.indexOf(month);
  const year = 2000 + Number(yy);
  if (Number(day) < 1 || Number(day) > new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate())
    return null;
  return contractSymbol({
    tradingSymbol: base,
    drvExpiryDate: `${year}-${pad(monthIndex + 1)}-${day}`,
    drvOptionType: kind === 'CE' ? 'CALL' : kind === 'PE' ? 'PUT' : null,
    drvStrikePrice: strike,
  });
}

/**
 * The journal's name for an F&O contract, or null when the name does not
 * carry enough to build it reliably. `formats` lists the broker's naming
 * styles: 'kite' (kept as is), 'dated' (DDMMMYY) and 'spaced'. Kite and dated
 * names can look alike (NIFTY26OCT25000CE), so each broker names its own.
 */
export function fnoSymbol(value, formats) {
  const text = String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/^(NSE|BSE|NFO|BFO):/, '');
  if (formats.includes('kite') && KITE_CONTRACT.test(text)) return text;
  let match = formats.includes('dated') && DATED_CONTRACT.exec(text);
  if (match) {
    const [, base, day, month, yy, strike, kind] = match;
    return fromParts(base, day, month, yy, strike, kind ?? 'FUT');
  }
  match = formats.includes('spaced') && SPACED_CONTRACT.exec(text);
  if (match) {
    const [, base, strike, kind, day, month, yy] = match;
    return fromParts(base, day, month, yy, strike, kind ?? 'FUT');
  }
  return null;
}

/**
 * ISO time for a broker's IST timestamp: "YYYY-MM-DD HH:MM:SS",
 * "DD-Mon-YYYY HH:MM:SS", "HH:MM:SS" (on `tradingDate`) or epoch seconds/ms;
 * null when unreadable.
 */
export function istToIso(value, tradingDate) {
  const text = String(value ?? '').trim();
  if (/^\d{10}(\d{3})?$/.test(text)) {
    const epoch = Number(text);
    return new Date(text.length === 10 ? epoch * 1000 : epoch).toISOString();
  }
  let iso = null;
  let match;
  if ((match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text))) {
    iso = `${match[1]}T${match[2]}`;
  } else if ((match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(text))) {
    const month = MONTHS.indexOf(match[2].toUpperCase()) + 1;
    if (month) iso = `${match[3]}-${pad(month)}-${match[1]}T${match[4]}`;
  } else if ((match = /^(\d{2}:\d{2}:\d{2})$/.exec(text)) && tradingDate) {
    iso = `${tradingDate}T${match[1]}`;
  }
  if (!iso) return null;
  const date = new Date(`${iso}+05:30`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The journal symbol of a broker row on `exchange` (F&O names read with
 * `formats`, see fnoSymbol), or a reason it was skipped.
 * @returns {{ symbol: string|null, problem: string|null }}
 */
export function instrumentSymbol(label, exchange, rawSymbol, formats) {
  if (exchange === 'NFO' || exchange === 'BFO') {
    const symbol = fnoSymbol(rawSymbol, formats);
    return symbol
      ? { symbol, problem: null }
      : {
          symbol: null,
          problem: `The ${label} contract name could not be read reliably. Add this trade by hand.`,
        };
  }
  const symbol = equitySymbol(rawSymbol);
  return symbol
    ? { symbol, problem: null }
    : { symbol: null, problem: `${label} did not name the instrument.` };
}

/**
 * Builds fills from broker rows already reduced to { symbol, rawSymbol,
 * exchange, product, side, quantity, price, tradeId, orderId, filledAt,
 * problem }. Rows from another IST day are dropped; unreadable rows are
 * returned in `skipped` with the reason.
 */
export function rowsToFills(rows, tradingDate) {
  const fills = [];
  const skipped = [];
  for (const row of rows) {
    if (row.filledAt && brokerTradingDate(Date.parse(row.filledAt)) !== tradingDate) continue;
    const quantity = Number(row.quantity);
    const price = Number(row.price);
    const tradeId = String(row.tradeId ?? '').trim() || String(row.orderId ?? '').trim();
    const problem =
      row.problem ??
      (!['BUY', 'SELL'].includes(row.side)
        ? 'The buy/sell side is missing.'
        : !Number.isInteger(quantity) || quantity <= 0
          ? 'The quantity is missing or invalid.'
          : !(price > 0)
            ? 'The price is missing or invalid.'
            : !tradeId
              ? 'The trade has no ID.'
              : null);
    if (problem) {
      skipped.push({
        symbol: row.symbol || String(row.rawSymbol ?? '').slice(0, 60) || 'Unknown',
        exchange: row.exchange ?? '',
        reason: problem,
      });
      continue;
    }
    fills.push({
      symbol: row.symbol,
      exchange: row.exchange,
      product: row.product,
      side: row.side,
      quantity,
      averagePrice: price,
      tradeId,
      orderId: String(row.orderId ?? ''),
      filledAt: row.filledAt,
    });
  }
  return { fills, skipped };
}

/** Adds a signed quantity carried in from earlier days under `exchange:symbol:product`. */
export function addCarried(carried, key, quantity) {
  if (Number.isInteger(quantity) && quantity !== 0)
    carried.set(key, (carried.get(key) ?? 0) + quantity);
}

/** Adds a delivery holding; it can be sold on either exchange. */
export function addHolding(carried, symbol, quantity) {
  if (!symbol || !Number.isInteger(quantity) || quantity <= 0) return;
  for (const exchange of ['NSE', 'BSE']) addCarried(carried, `${exchange}:${symbol}:CNC`, quantity);
}
