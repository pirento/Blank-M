import { describe, expect, it } from 'vitest';
import {
  buildCandidates,
  findDuplicateLines,
  guessMapping,
  normaliseDate,
  normaliseDirection,
  normaliseNumber,
  parseCsv,
  tradeKey,
} from '../../shared/csv.js';
import { buildTradesCsv } from '../../shared/trade-export.js';

describe('parseCsv', () => {
  it('reads a plain file', () => {
    const { headers, rows } = parseCsv('a,b\n1,2\n3,4');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,b\n"one, two",3').rows).toEqual([['one, two', '3']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""').rows).toEqual([['he said "hi"']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,b\n"line one\nline two",x').rows).toEqual([['line one\nline two', 'x']]);
  });

  it('handles CRLF endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([['1', '2']]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    expect(parseCsv('\uFEFFDate,Symbol\n2026-01-02,TCS').headers).toEqual(['Date', 'Symbol']);
  });

  it('trims header whitespace but not field values', () => {
    const { headers, rows } = parseCsv(' Date , Symbol \n 2026-01-02 ,TCS');
    expect(headers).toEqual(['Date', 'Symbol']);
    expect(rows[0]?.[0]).toBe(' 2026-01-02 ');
  });

  it('ignores a trailing newline rather than inventing an empty row', () => {
    expect(parseCsv('a\n1\n').rows).toHaveLength(1);
  });

  it('returns nothing useful for an empty file', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});

describe('guessMapping', () => {
  it('maps a Zerodha-style header row', () => {
    const mapping = guessMapping([
      'Symbol',
      'Trade Date',
      'Trade Type',
      'Quantity',
      'Entry Price',
      'Exit Price',
    ]);
    expect(mapping.symbol).toBe(0);
    expect(mapping.date).toBe(1);
    expect(mapping.type).toBe(2);
    expect(mapping.quantity).toBe(3);
    expect(mapping.entryPrice).toBe(4);
    expect(mapping.exitPrice).toBe(5);
  });

  it('matches regardless of case, spaces or underscores', () => {
    const mapping = guessMapping(['TRADE_DATE', 'trading symbol', 'buy/sell']);
    expect(mapping.date).toBe(0);
    expect(mapping.symbol).toBe(1);
    expect(mapping.type).toBe(2);
  });

  it('prefers an exact alias over a partial one', () => {
    // "Price" must not steal the entry slot from "Entry Price".
    const mapping = guessMapping(['Price', 'Entry Price', 'Exit Price']);
    expect(mapping.entryPrice).toBe(1);
    expect(mapping.exitPrice).toBe(2);
  });

  it('never binds one column to two fields', () => {
    const mapping = guessMapping(['Date', 'Symbol', 'Qty']);
    const used = Object.values(mapping).filter((index) => index !== -1);
    expect(new Set(used).size).toBe(used.length);
  });

  it('reports -1 for fields it cannot find', () => {
    expect(guessMapping(['Something', 'Else']).date).toBe(-1);
  });
});

describe('normaliseDate', () => {
  it('passes ISO through', () => {
    expect(normaliseDate('2026-03-04')).toBe('2026-03-04');
  });

  it('drops a time component', () => {
    expect(normaliseDate('2026-03-04T09:15:00')).toBe('2026-03-04');
    expect(normaliseDate('2026-03-04 09:15')).toBe('2026-03-04');
  });

  it('reads separated numeric dates day-first, as Indian brokers write them', () => {
    expect(normaliseDate('03/04/2026')).toBe('2026-04-03');
    expect(normaliseDate('13-05-2026')).toBe('2026-05-13');
    expect(normaliseDate('13.05.2026')).toBe('2026-05-13');
  });

  it('pads single-digit days and months', () => {
    expect(normaliseDate('3/4/2026')).toBe('2026-04-03');
  });

  it('reads named months', () => {
    expect(normaliseDate('13-May-2026')).toBe('2026-05-13');
    expect(normaliseDate('13 September 2026')).toBe('2026-09-13');
  });

  it('rejects impossible calendar dates', () => {
    expect(normaliseDate('31-02-2026')).toBeNull();
    expect(normaliseDate('2026-13-01')).toBeNull();
  });

  it('rejects what it does not understand rather than guessing', () => {
    expect(normaliseDate('')).toBeNull();
    expect(normaliseDate('yesterday')).toBeNull();
    expect(normaliseDate('05-2026')).toBeNull();
  });
});

describe('normaliseDirection', () => {
  it('reads the long side', () => {
    for (const value of ['Long', 'BUY', 'b', 'bought', ' long ']) {
      expect(normaliseDirection(value)).toBe('Long');
    }
  });

  it('reads the short side', () => {
    for (const value of ['Short', 'SELL', 's', 'sold']) {
      expect(normaliseDirection(value)).toBe('Short');
    }
  });

  it('returns null for anything else', () => {
    expect(normaliseDirection('')).toBeNull();
    expect(normaliseDirection('maybe')).toBeNull();
  });
});

describe('normaliseNumber', () => {
  it('reads a plain number', () => {
    expect(normaliseNumber('1234.56')).toBe(1234.56);
  });

  it('reads Indian digit grouping', () => {
    expect(normaliseNumber('1,23,456.78')).toBe(123456.78);
  });

  it('strips a currency symbol', () => {
    expect(normaliseNumber('₹ 1,000')).toBe(1000);
  });

  it('reads negatives written with a sign or brackets', () => {
    expect(normaliseNumber('-500')).toBe(-500);
    expect(normaliseNumber('(500)')).toBe(-500);
  });

  it('rejects non-numeric text rather than returning NaN', () => {
    expect(normaliseNumber('')).toBeNull();
    expect(normaliseNumber('n/a')).toBeNull();
    expect(normaliseNumber('12abc')).toBeNull();
  });

  it.each([
    '10000000000000.0001',
    '9007199254740993',
    '1.0000000000000001',
    `0.${'0'.repeat(330)}1`,
  ])('rejects source digits that would disappear during numeric conversion: %s', (value) =>
    expect(normaliseNumber(value)).toBeNull(),
  );

  it.each([
    ['000125.0123000', 125.0123],
    ['0.0000001', 1e-7],
    ['1000000000000000000000', 1e21],
    ['(₹ 1,25,000.0123)', -125000.0123],
  ])('retains representable decimals despite display notation: %s', (raw, value) => {
    expect(normaliseNumber(raw)).toBe(value);
  });
});

describe('buildCandidates', () => {
  const mapping = {
    date: 0,
    symbol: 1,
    type: 2,
    entryPrice: 3,
    exitPrice: 4,
    quantity: 5,
    notes: 6,
  };

  it('blocks lossy and out-of-range rows during preview before any persistence', () => {
    const { candidates, errors } = buildCandidates(
      [
        ['13-05-2026', 'TCS', 'BUY', '10000000000000.0001', '100', '1', ''],
        ['13-05-2026', 'TCS', 'BUY', '100000000000000', '100', '1', ''],
        ['13-05-2026', 'TCS', 'BUY', '100', '101', '100000000000000', ''],
        ['13-05-2026', 'TCS', 'BUY', '125.0123', '126.0123', '10', ''],
      ],
      mapping,
    );
    expect(errors.map((error) => error.line)).toEqual([2, 3, 4]);
    expect(errors[0]?.reason).toMatch(/lost decimal precision/);
    expect(errors[1]?.reason).toMatch(/supported record range/);
    expect(errors[2]?.reason).toMatch(/supported record range/);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ line: 5, entryPrice: 125.0123, quantity: 10 });
  });

  it('builds a trade from a good row', () => {
    const { candidates, errors } = buildCandidates(
      [['13-05-2026', 'tcs', 'BUY', '1,000', '1010', '100', 'breakout']],
      mapping,
    );
    expect(errors).toEqual([]);
    expect(candidates[0]).toEqual({
      line: 2,
      date: '2026-05-13',
      symbol: 'TCS',
      type: 'Long',
      entryPrice: 1000,
      exitPrice: 1010,
      quantity: 100,
      notes: 'breakout',
    });
  });

  it('numbers rows from the file, counting the header as line 1', () => {
    const { candidates } = buildCandidates(
      [
        ['2026-01-01', 'A', 'buy', '1', '2', '1', ''],
        ['2026-01-02', 'B', 'buy', '1', '2', '1', ''],
      ],
      mapping,
    );
    expect(candidates.map((c) => c.line)).toEqual([2, 3]);
  });

  it('keeps the good rows and reports the bad ones', () => {
    const { candidates, errors } = buildCandidates(
      [
        ['2026-01-01', 'A', 'buy', '10', '11', '5', ''],
        ['not a date', 'B', 'buy', '10', '11', '5', ''],
        ['2026-01-03', 'C', 'buy', '10', '11', '5', ''],
      ],
      mapping,
    );
    expect(candidates.map((c) => c.symbol)).toEqual(['A', 'C']);
    expect(errors).toEqual([{ line: 3, reason: 'Could not read a date from "not a date"' }]);
  });

  it('skips entirely blank rows silently', () => {
    const { candidates, errors } = buildCandidates([['', '', '', '', '', '', '']], mapping);
    expect(candidates).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('rejects zero and negative prices and quantities', () => {
    const { errors } = buildCandidates(
      [
        ['2026-01-01', 'A', 'buy', '0', '11', '5', ''],
        ['2026-01-02', 'B', 'buy', '10', '11', '-5', ''],
      ],
      mapping,
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]?.reason).toMatch(/greater than zero/);
  });

  it('rejects a fractional share count', () => {
    const { errors } = buildCandidates(
      [['2026-01-01', 'A', 'buy', '10', '11', '2.5', '']],
      mapping,
    );
    expect(errors[0]?.reason).toMatch(/not a whole number/);
  });

  it('treats an unmapped notes column as an empty note rather than an error', () => {
    const { candidates, errors } = buildCandidates([['2026-01-01', 'A', 'buy', '10', '11', '5']], {
      ...mapping,
      notes: -1,
    });
    expect(errors).toEqual([]);
    expect(candidates[0]?.notes).toBe('');
  });
});

describe('duplicate detection', () => {
  const base = {
    date: '2026-01-01',
    symbol: 'TCS',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
  };

  it('builds the same key regardless of symbol case', () => {
    expect(tradeKey(base)).toBe(tradeKey({ ...base, symbol: 'tcs' }));
  });

  it('distinguishes trades that differ in any field', () => {
    expect(tradeKey(base)).not.toBe(tradeKey({ ...base, quantity: 11 }));
    expect(tradeKey(base)).not.toBe(tradeKey({ ...base, type: 'Short' }));
  });

  it('flags a candidate that already exists in the book', () => {
    const lines = findDuplicateLines([{ ...base, line: 2, notes: '' }], [base]);
    expect([...lines]).toEqual([2]);
  });

  it('flags the second occurrence within one file, not the first', () => {
    const lines = findDuplicateLines(
      [
        { ...base, line: 2, notes: '' },
        { ...base, line: 3, notes: '' },
      ],
      [],
    );
    expect([...lines]).toEqual([3]);
  });

  it('flags nothing when every row is distinct', () => {
    const lines = findDuplicateLines(
      [
        { ...base, line: 2, notes: '' },
        { ...base, line: 3, quantity: 20, notes: '' },
      ],
      [],
    );
    expect(lines.size).toBe(0);
  });
});

describe('CSV import fixes', () => {
  it('reports source line numbers, keeps F&O segments and ignores "Order Type"', () => {
    const text =
      'Date,Symbol,Transaction Type,Order Type,Entry,Exit,Qty\n\n' +
      '13-05-2026,INFY,BUY,MARKET,abc,2,1\n' +
      '13-05-2026,NIFTY26OCT24500CE,BUY,LIMIT,100,120,75\n';
    const parsed = parseCsv(text);
    const mapping = guessMapping(parsed.headers);
    expect(parsed.headers[mapping.type]).toBe('Transaction Type');
    const { candidates, errors } = buildCandidates(parsed.rows, mapping);
    expect(errors.map((error) => error.line)).toEqual([3]);
    expect(candidates[0]).toMatchObject({ line: 4, segment: 'OPT', optionType: 'CE' });
  });

  it('round-trips F&O contract details through the trade-book export', () => {
    const base = { date: '2026-10-05', type: 'Long', grossPnl: 0, charges: 0, pnl: 0, notes: '' };
    const csv = buildTradesCsv([
      {
        ...base,
        symbol: 'NIFTY',
        quantity: 150,
        entryPrice: 100,
        exitPrice: 120,
        segment: 'OPT',
        strike: 24500,
        optionType: 'PE',
        expiry: '2026-10-28',
        lotSize: 75,
      },
      { ...base, symbol: 'TCS', quantity: 5, entryPrice: 4000, exitPrice: 4100, segment: 'EQ' },
    ]);
    const parsed = parseCsv(csv);
    const { candidates, errors } = buildCandidates(parsed.rows, guessMapping(parsed.headers));
    expect(errors).toEqual([]);
    expect(candidates[0]).toMatchObject({
      symbol: 'NIFTY',
      quantity: 150,
      segment: 'OPT',
      strike: 24500,
      optionType: 'PE',
      expiry: '2026-10-28',
      lotSize: 75,
    });
    expect(candidates[1]).not.toHaveProperty('segment');
  });

  it('rejects a re-imported F&O row whose quantity is not whole lots', () => {
    const csv =
      'Date,Symbol,Direction,Quantity,Entry,Exit,Segment,Lot size\n2026-10-05,NIFTY,Long,100,1,2,FUT,75';
    const parsed = parseCsv(csv);
    const { errors } = buildCandidates(parsed.rows, guessMapping(parsed.headers));
    expect(errors[0].reason).toMatch(/multiple of the lot size/);
  });

  it('never reads a "Lots" or "Lot size" column as the quantity', () => {
    expect(guessMapping(['Date', 'Symbol', 'Lots']).quantity).toBe(-1);
    expect(guessMapping(['Lot size', 'Qty']).quantity).toBe(1);
    expect(guessMapping(['Lot Size']).quantity).toBe(-1);
  });
});
