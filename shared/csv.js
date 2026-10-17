/**
 * Parsing and normalising broker trade exports.
 *
 * Manual entry is the reason trading journals get abandoned, so this has to
 * cope with whatever a broker actually emits rather than one blessed format.
 * Everything here is pure and unit-tested; the page above it only maps columns
 * and shows the result.
 */

/**
 * A hand-rolled RFC 4180 reader rather than a dependency.
 *
 * The cases that matter are quoted fields containing commas, escaped quotes
 * (`""`), embedded newlines, CRLF endings and a UTF-8 BOM — all of which appear
 * in real broker exports and all of which a naive `split(',')` gets wrong.
 */
export function parseCsv(text) {
  // Escaped rather than literal: an invisible BOM in source is unreadable.
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline must not produce a phantom empty row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const character = input[index];

    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      endField();
      index += 1;
      continue;
    }
    if (character === '\r') {
      // Treat CRLF as one break, and a lone CR as a break too.
      if (input[index + 1] === '\n') index += 1;
      endRow();
      index += 1;
      continue;
    }
    if (character === '\n') {
      endRow();
      index += 1;
      continue;
    }

    field += character;
    index += 1;
  }

  if (field !== '' || row.length > 0) endRow();

  const [headers = [], ...body] = rows;
  return { headers: headers.map((header) => header.trim()), rows: body };
}

/* --------------------------------- mapping --------------------------------- */

/** Column index for each field; -1 means "not mapped". */
export const REQUIRED_FIELDS = ['date', 'symbol', 'type', 'entryPrice', 'exitPrice', 'quantity'];

/**
 * Header aliases seen across common Indian broker exports, plus the
 * obvious generic spellings. Matching is on a squashed lowercase form so
 * "Entry Price", "entry_price" and "ENTRYPRICE" all land together.
 */
const FIELD_ALIASES = {
  date: ['date', 'tradedate', 'orderdate', 'tradingdate', 'entrydate', 'executiondate', 'day'],
  symbol: [
    'symbol',
    'tradingsymbol',
    'scrip',
    'scripname',
    'instrument',
    'stock',
    'name',
    'ticker',
  ],
  type: ['type', 'tradetype', 'side', 'buysell', 'transactiontype', 'direction', 'ordertype'],
  entryPrice: [
    'entryprice',
    'entry',
    'buyprice',
    'buyavg',
    'avgbuyprice',
    'openprice',
    'entryrate',
  ],
  exitPrice: [
    'exitprice',
    'exit',
    'sellprice',
    'sellavg',
    'avgsellprice',
    'closeprice',
    'exitrate',
  ],
  quantity: ['quantity', 'qty', 'shares', 'units', 'lots', 'filledqty', 'tradedqty'],
  notes: ['notes', 'note', 'remarks', 'comment', 'comments', 'description'],
};

function squash(header) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Best-effort column guess so the common case needs no configuration. An exact
 * alias wins over a partial match, so a file with both "Price" and "Entry
 * Price" does not bind the wrong one.
 */
export function guessMapping(headers) {
  const squashed = headers.map(squash);
  const mapping = {};
  const taken = new Set();

  for (const field of Object.keys(FIELD_ALIASES)) {
    const aliases = FIELD_ALIASES[field];
    let found = squashed.findIndex(
      (header, index) => !taken.has(index) && aliases.includes(header),
    );
    if (found === -1) {
      found = squashed.findIndex(
        (header, index) =>
          !taken.has(index) && aliases.some((alias) => alias.length > 3 && header.includes(alias)),
      );
    }
    mapping[field] = found;
    if (found !== -1) taken.add(found);
  }

  const priceColumns = squashed
    .map((header) => {
      if (['buyprice', 'buyavg', 'avgbuyprice'].some((alias) => header.includes(alias)))
        return 'buy';
      if (['sellprice', 'sellavg', 'avgsellprice'].some((alias) => header.includes(alias)))
        return 'sell';
      if (
        header === 'entry' ||
        ['entryprice', 'openprice', 'entryrate'].some((alias) => header.includes(alias))
      )
        return 'entry';
      if (
        header === 'exit' ||
        ['exitprice', 'closeprice', 'exitrate'].some((alias) => header.includes(alias))
      )
        return 'exit';
      return null;
    })
    .filter(Boolean);
  const hasSides = priceColumns.includes('buy') || priceColumns.includes('sell');
  mapping.priceBasis = hasSides
    ? priceColumns.length === 2 && priceColumns.includes('buy') && priceColumns.includes('sell')
      ? 'buy-sell'
      : 'ambiguous'
    : priceColumns.length > 2 || new Set(priceColumns).size !== priceColumns.length
      ? 'ambiguous'
      : 'entry-exit';
  return mapping;
}

/**
 * User-facing reason a column mapping cannot be imported (ambiguous price basis, or two required
 * fields on one column), or null if it is usable. Unmapped (-1) fields are not checked here.
 */
export function mappingProblem(mapping) {
  if (mapping.priceBasis === 'ambiguous')
    return 'Ambiguous price columns. Choose Entry/Exit or Buy/Sell and map the corresponding pair explicitly.';
  const selected = REQUIRED_FIELDS.map((field) => mapping[field]).filter((column) => column !== -1);
  if (new Set(selected).size !== selected.length)
    return 'Each required field needs a different column.';
  return null;
}

/* ------------------------------- normalising ------------------------------- */

const MONTHS = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/**
 * Returns YYYY-MM-DD, or null if the value is not a date this understands.
 *
 * **Day-first is assumed** for all-numeric separated dates, because this is an
 * Indian-market tool and every broker here writes DD-MM-YYYY. `03/04/2026` is
 * therefore 3 April, not 4 March. Guessing per row from whether a component
 * exceeds 12 would make one file parse two different ways, which is worse than
 * a stated convention.
 */
export function normaliseDate(value) {
  const raw = value.trim();
  if (!raw) return null;

  // Already ISO, possibly with a time component.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(raw);
  if (iso) return validDate(iso[1], iso[2], iso[3]);

  // 13-05-2026, 13/05/2026, 13.05.2026 — day first.
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ].*)?$/.exec(raw);
  if (dayFirst) {
    return validDate(dayFirst[3], dayFirst[2].padStart(2, '0'), dayFirst[1].padStart(2, '0'));
  }

  // 13-May-2026 / 13 May 2026
  const named = /^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{4})/.exec(raw);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month) return validDate(named[3], month, named[1].padStart(2, '0'));
  }

  return null;
}

/** Rejects impossible calendar dates such as 31 February. */
function validDate(year, month, day) {
  const candidate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(candidate.getTime())) return null;
  if (candidate.getUTCMonth() + 1 !== Number(month) || candidate.getUTCDate() !== Number(day)) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/**
 * A broker row says BUY or SELL, meaning the side of the *opening* leg. A buy
 * that is later sold is a Long; a short sale closed by a buy is a Short.
 */
export function normaliseDirection(value) {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (['long', 'buy', 'b', 'bought', 'buy/long', 'l'].includes(raw)) return 'Long';
  if (['short', 'sell', 's', 'sold', 'sell/short', 'sh'].includes(raw)) return 'Short';
  return null;
}

function canonicalDecimal(raw) {
  const [whole = '', fraction = ''] = raw.split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  const decimals = fraction.replace(/0+$/, '');
  return decimals ? `${integer}.${decimals}` : integer;
}

function expandedNumber(value) {
  const [mantissa = '0', exponent] = String(value).split('e');
  if (exponent === undefined) return mantissa;
  const [whole = '', fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Parses a broker cell without silently losing source digits, tolerating Indian
 * digit grouping ("1,23,456.78"), currency symbols and parenthesised negatives.
 */
export function normaliseNumber(value) {
  let raw = value
    .trim()
    .replace(/[₹$\s]/g, '')
    .replace(/,/g, '');
  if (!raw) return null;

  let sign = 1;
  if (/^\(.*\)$/.test(raw)) {
    sign = -1;
    raw = raw.slice(1, -1);
  }
  if (raw.startsWith('-')) {
    sign = -1;
    raw = raw.slice(1);
  }

  if (!/^\d*\.?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  // Preserve the source decimal before converting it into a JS number. Checking
  // only the converted value cannot detect a large price losing its fraction.
  if (canonicalDecimal(raw) !== canonicalDecimal(expandedNumber(parsed))) return null;
  return parsed * sign;
}

/* -------------------------------- assembling -------------------------------- */

function cell(row, index) {
  return index === -1 ? '' : (row[index] ?? '');
}

/**
 * Turns raw rows into importable trades, collecting a reason for every row it
 * rejects rather than failing the whole file. A broker export with three bad
 * rows out of two hundred should still import a hundred and ninety-seven.
 */
export function buildCandidates(rows, mapping) {
  const candidates = [];
  const errors = [];

  rows.forEach((row, index) => {
    // +2 because line 1 is the header and the caller counts from 1.
    const line = index + 2;
    if (row.every((value) => value.trim() === '')) return;

    const problem = mappingProblem(mapping);
    if (problem) {
      errors.push({ line, reason: problem });
      return;
    }

    const date = normaliseDate(cell(row, mapping.date));
    if (!date) {
      errors.push({ line, reason: `Could not read a date from "${cell(row, mapping.date)}"` });
      return;
    }

    const symbol = cell(row, mapping.symbol).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,24}$/.test(symbol)) {
      errors.push({
        line,
        reason: symbol
          ? 'Symbol must use 1–25 letters, digits, dots, underscores or hyphens, starting with a letter or digit'
          : 'No symbol',
      });
      return;
    }

    const type = normaliseDirection(cell(row, mapping.type));
    if (!type) {
      errors.push({
        line,
        reason: `"${cell(row, mapping.type)}" is not a recognised buy/sell or long/short`,
      });
      return;
    }

    const reversed = mapping.priceBasis === 'buy-sell' && type === 'Short';
    const entryPrice = normaliseNumber(
      cell(row, reversed ? mapping.exitPrice : mapping.entryPrice),
    );
    const exitPrice = normaliseNumber(cell(row, reversed ? mapping.entryPrice : mapping.exitPrice));
    const quantity = normaliseNumber(cell(row, mapping.quantity));

    if (entryPrice === null || exitPrice === null || quantity === null) {
      errors.push({
        line,
        reason: 'Entry, exit and quantity must be valid numbers without lost decimal precision',
      });
      return;
    }
    if (entryPrice <= 0 || exitPrice <= 0 || quantity <= 0) {
      errors.push({ line, reason: 'Entry, exit and quantity must all be greater than zero' });
      return;
    }
    if (entryPrice >= 1e14 || exitPrice >= 1e14 || quantity >= 1e14) {
      errors.push({ line, reason: 'Entry, exit or quantity exceeds the supported record range' });
      return;
    }
    if (
      entryPrice !== Number(entryPrice.toFixed(4)) ||
      exitPrice !== Number(exitPrice.toFixed(4))
    ) {
      errors.push({
        line,
        reason:
          'Prices support at most four decimal places. Correct the source value before importing.',
      });
      return;
    }
    if (!Number.isInteger(quantity)) {
      errors.push({ line, reason: `Quantity ${quantity} is not a whole number of shares` });
      return;
    }

    candidates.push({
      line,
      date,
      symbol,
      type,
      entryPrice,
      exitPrice,
      quantity,
      notes: cell(row, mapping.notes).trim(),
    });
  });

  return { candidates, errors };
}

/**
 * Identity of a trade for duplicate detection. Matching values are only a duplicate warning: legitimate identical
 * round trips can exist. The user can include them explicitly. Retry identity
 * is handled separately by the import operation ledger.
 */
export function tradeKey(trade) {
  return [
    trade.date,
    trade.symbol.toUpperCase(),
    trade.type,
    trade.entryPrice,
    trade.exitPrice,
    trade.quantity,
  ].join('|');
}

/**
 * Lines that already exist in the book, or that repeat an earlier line in the
 * same file. Returned as a set of line numbers so the preview can mark them.
 */
export function findDuplicateLines(candidates, existing) {
  const seen = new Set(existing.map(tradeKey));
  const duplicates = new Set();

  for (const candidate of candidates) {
    const key = tradeKey(candidate);
    if (seen.has(key)) duplicates.add(candidate.line);
    else seen.add(key);
  }

  return duplicates;
}

/** Quote every text cell and neutralize formula prefixes after whitespace/control characters.
 * Typed numeric cells must be serialized separately, preserving negative P&L as a number.
 */
export function csvTextCell(value) {
  const prefixStripped = value.replace(/^[\s\p{Cc}\p{Cf}]*/u, '');
  const safe = /^[=+@-]/.test(prefixStripped) ? "'" + value : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
