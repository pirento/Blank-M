import { describe, expect, it } from 'vitest';
import { buildTradesCsv } from '../../shared/trade-export.js';
import {
  inReportPeriod,
  instantBusinessDate,
  isBusinessDate,
  isBusinessMonth,
  reportPeriod,
} from '../../shared/business-dates.js';
import {
  buildCandidates,
  csvTextCell,
  guessMapping,
  mappingProblem,
  parseCsv,
} from '../../shared/csv.js';
import {
  buildEquityCurve,
  computeGrossPnl,
  computeTradeEconomics,
  economicsForTradeEdit,
  filterByRange,
  periodOpeningBalance,
  rangeStart,
  tradeEconomicsChanged,
} from '../../shared/pnl.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';

function trade(overrides = {}) {
  return {
    id: 'synthetic-trade',
    date: '2026-10-05',
    symbol: 'TCS',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    grossPnl: 100,
    charges: 5,
    pnl: 95,
    notes: '',
    strategyId: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('strict calendar report periods', () => {
  it.each(['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '9999-12-31'])(
    'accepts the valid Gregorian date %s',
    (date) => {
      expect(isBusinessDate(date)).toBe(true);
      expect(reportPeriod('daily', date)).toEqual({
        type: 'daily',
        key: date,
        start: date,
        end: date,
      });
    },
  );

  it.each([
    '',
    ' ',
    '0000-01-01',
    '10000-01-01',
    '-000001-01-01',
    '1900-02-29',
    '2026-02-29',
    '2026-02-31',
    '2026-04-31',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '2026-1-01',
    '2026-01-1',
    '2026-01-01T00:00:00Z',
    ' 2026-01-01',
    '2026-01-01\n',
  ])('rejects the invalid daily key %j', (date) => {
    expect(isBusinessDate(date)).toBe(false);
    expect(reportPeriod('daily', date)).toBeNull();
  });

  it.each([
    ['0001-01', '0001-01-31'],
    ['0099-02', '0099-02-28'],
    ['1900-02', '1900-02-28'],
    ['2000-02', '2000-02-29'],
    ['2026-04', '2026-04-30'],
    ['9999-12', '9999-12-31'],
  ])('keeps inclusive month end within the supported years for %s', (month, end) => {
    expect(isBusinessMonth(month)).toBe(true);
    expect(reportPeriod('monthly', month)).toEqual({
      type: 'monthly',
      key: month,
      start: `${month}-01`,
      end,
    });
  });

  it.each(['', '0000-01', '10000-01', '2026-00', '2026-13', '2026-1', '2026-01-01', '2026-01\n'])(
    'rejects the invalid monthly key %j',
    (month) => {
      expect(isBusinessMonth(month)).toBe(false);
      expect(reportPeriod('monthly', month)).toBeNull();
    },
  );

  it('includes both monthly endpoints and rejects invalid dates, absent periods and timestamps', () => {
    const period = reportPeriod('monthly', '2024-02');
    for (const date of ['2024-02-01', '2024-02-29'])
      expect(inReportPeriod(date, period)).toBe(true);
    for (const date of [
      null,
      '',
      '2024-01-31',
      '2024-03-01',
      '2024-02-30',
      '2024-02-15T00:00:00Z',
    ]) {
      expect(inReportPeriod(date, period)).toBe(false);
    }
    expect(inReportPeriod('2024-02-15', null)).toBe(false);
  });
});

describe('instant to IST business-day boundaries', () => {
  it.each([
    ['2026-10-04T18:29:59.999Z', '2026-10-04'],
    ['2026-10-04T18:30:00Z', '2026-10-05'],
    ['2026-09-30T18:30:00Z', '2026-10-01'],
    ['2025-12-31T18:30:00Z', '2026-01-01'],
    ['2024-02-29T18:30:00Z', '2024-03-01'],
    ['2026-10-05T00:00:00+05:30', '2026-10-05'],
    ['2026-10-05T00:10:00+05:45', '2026-10-04'],
    ['2026-10-04T13:30:00-05:00', '2026-10-05'],
    ['0001-01-01T12:00:00Z', '0001-01-01'],
    ['0099-01-01T12:00:00Z', '0099-01-01'],
    ['9999-12-31T18:29:59Z', '9999-12-31'],
  ])('assigns %s to %s', (timestamp, expected) => {
    expect(instantBusinessDate(timestamp)).toBe(expected);
  });

  it.each([
    '',
    'not a timestamp',
    '2026-10-05',
    '2026-10-05T12:00:00',
    '2026-10-05 12:00:00Z',
    '2026-10-05T12:00Z',
    '2026-02-30T00:00:00Z',
    '2026-10-05T24:00:00Z',
    '2026-10-05T25:00:00Z',
    '2026-10-05T12:60:00Z',
    '2026-10-05T12:00:60Z',
    '2026-10-05T12:00:00+24:00',
    '2026-10-05T12:00:00+05:60',
    '2026-10-05T12:00:00+0530',
    '2026-10-05T12:00:00Z\n',
    '0000-01-01T12:00:00Z',
    '10000-01-01T12:00:00Z',
    '0001-01-01T00:00:00+14:00',
    '9999-12-31T18:30:00Z',
  ])('rejects malformed or out-of-bounds instant %j without throwing', (timestamp) => {
    expect(instantBusinessDate(timestamp)).toBeNull();
  });

  it('uses the converted date for both daily and monthly membership', () => {
    const midnight = instantBusinessDate('2026-09-30T18:30:00Z');
    expect(inReportPeriod(midnight, reportPeriod('daily', '2026-10-01'))).toBe(true);
    expect(inReportPeriod(midnight, reportPeriod('monthly', '2026-10'))).toBe(true);
    expect(inReportPeriod(midnight, reportPeriod('monthly', '2026-09'))).toBe(false);
  });
});

describe('bounded P&L ranges and opening equity', () => {
  const now = new Date('2025-12-31T18:30:00Z'); // January 1 in IST, December 31 in UTC.

  it.each([
    ['7d', '2025-12-26'],
    ['30d', '2025-12-03'],
    ['90d', '2025-10-04'],
    ['ytd', '2026-01-01'],
  ])('uses inclusive IST boundaries for %s', (range, start) => {
    expect(rangeStart(range, now)).toBe(start);
    const rows = [
      trade({ id: 'older', date: '2025-01-01' }),
      trade({ id: 'start', date: start }),
      trade({ id: 'end', date: '2026-01-01' }),
      trade({ id: 'future', date: '2026-01-02' }),
    ];
    expect(filterByRange(rows, range, now).map(({ id }) => id)).toEqual(['start', 'end']);
    expect(rows.map(({ id }) => id)).toEqual(['older', 'start', 'end', 'future']);
  });

  it('keeps all-time history unrestricted and its opening balance unchanged', () => {
    const rows = [trade({ date: '2025-01-01' }), trade({ date: '2027-01-01' })];
    expect(rangeStart('all', now)).toBeNull();
    expect(filterByRange(rows, 'all', now)).toEqual(rows);
    expect(periodOpeningBalance(1000, rows, 'all', now)).toBe(1000);
  });

  it('carries only prior net P&L into the opening point, once, without future trades', () => {
    const rows = [
      trade({ date: '2025-12-25', pnl: -20.11, grossPnl: -10, charges: 10.11 }),
      trade({ date: '2025-12-01', pnl: 60.23, grossPnl: 70, charges: 9.77 }),
      trade({ date: '2025-12-26', pnl: 30 }),
      trade({ date: '2026-01-01', pnl: -5 }),
      trade({ date: '2026-01-02', pnl: 10000 }),
    ];
    const opening = periodOpeningBalance(1000, rows, '7d', now);
    expect(opening).toBe(1040.12);
    const curve = buildEquityCurve(opening, filterByRange(rows, '7d', now));
    expect(curve.map(({ balance }) => balance)).toEqual([1040.12, 1070.12, 1065.12]);
    expect(periodOpeningBalance(1000, [], '7d', now)).toBe(1000);
  });
});

describe('historical economics on metadata-only edits', () => {
  const original = trade({ grossPnl: 95, charges: 7.25, pnl: 87.75 });
  const currentCharges = { ...DEFAULT_CHARGES, enabled: false };

  it('preserves all stored economics when only notes, strategy or symbol formatting changes', () => {
    const input = {
      ...original,
      symbol: ' tcs ',
      notes: 'Revised notes',
      strategyId: 'new-strategy',
    };
    expect(tradeEconomicsChanged(original, input)).toBe(false);
    expect(economicsForTradeEdit(original, input, currentCharges)).toEqual({
      grossPnl: 95,
      charges: 7.25,
      netPnl: 87.75,
    });
    expect(original.notes).toBe('');
  });

  it.each([
    { date: '2026-10-04' },
    { symbol: 'INFY' },
    { type: 'Short' },
    { entryPrice: 101 },
    { exitPrice: 111 },
    { quantity: 11 },
  ])('recalculates using current settings for an economic edit %j', (change) => {
    const input = { ...original, ...change };
    expect(tradeEconomicsChanged(original, input)).toBe(true);
    expect(economicsForTradeEdit(original, input, currentCharges)).toEqual(
      computeTradeEconomics(input, currentCharges),
    );
  });

  it('computes economics for a newly created trade', () => {
    expect(economicsForTradeEdit(undefined, original, currentCharges)).toMatchObject({
      grossPnl: 100,
      charges: 0,
      netPnl: 100,
    });
  });
});

describe('CSV formula neutralization and numeric export', () => {
  it.each([
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(1,1)',
    '  =1+1',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1',
    '\r\n +1',
    '\u0000=1+1',
    '\u001f-1+1',
    '\u0085@SUM(1,1)',
    '\u00a0=1+1',
    '\u2003+1+1',
    '\u200b=1+1',
    '\u202e@SUM(1,1)',
    '\ufeff=1+1',
    '\t\u200b\u00a0\n=HYPERLINK("https://invalid.example","text")',
  ])('neutralizes a formula after whitespace/control prefix %j', (input) => {
    const parsed = parseCsv(`Notes\n${csvTextCell(input)}`);
    expect(parsed.rows).toEqual([[`'${input}`]]);
  });

  it.each(['ordinary text', 'First line, "quoted"\nSecond line', "'=1+1", 'text =1+1', '  notes'])(
    'preserves safe text and RFC 4180 escaping for %j',
    (input) => expect(parseCsv(`Notes\n${csvTextCell(input)}`).rows).toEqual([[input]]),
  );

  it('the transaction export sanitizes text while retaining negative and zero numeric cells', () => {
    const notes = '\u200b\n=SUM(1,1)';
    const csv = buildTradesCsv([
      trade({ symbol: '+SYNTHETIC', exitPrice: 90, grossPnl: -100, charges: 0, pnl: -100, notes }),
    ]);
    expect(csv).toContain(',10,100,90,-100,0,-100,');
    expect(parseCsv(csv).rows).toEqual([
      [
        '2026-10-05',
        "'+SYNTHETIC",
        'Long',
        '10',
        '100',
        '90',
        '-100',
        '0',
        '-100',
        `'${notes}`,
        '',
        '',
        '',
        'EQ',
        '',
        '',
        '',
        '',
      ],
    ]);
  });
});

describe('CSV price-basis mapping', () => {
  it.each([
    ['Entry Price', 'Exit Price', 'entry-exit', 'Long', 100, 110, 100, 110, 100],
    ['Entry Price', 'Exit Price', 'entry-exit', 'Short', 110, 100, 110, 100, 100],
    ['Buy Price', 'Sell Price', 'buy-sell', 'Long', 100, 110, 100, 110, 100],
    ['Buy Price', 'Sell Price', 'buy-sell', 'Short', 100, 110, 110, 100, 100],
    ['Buy Avg', 'Sell Avg', 'buy-sell', 'SELL', 110, 100, 100, 110, -100],
    ['Avg Buy Price', 'Avg Sell Price', 'buy-sell', 'BUY', 110, 100, 110, 100, -100],
  ])(
    'maps %s / %s %s for %s without reversing chronological prices',
    (firstHeader, secondHeader, basis, direction, first, second, entryPrice, exitPrice, pnl) => {
      const mapping = guessMapping([
        'Date',
        'Symbol',
        'Direction',
        'Qty',
        firstHeader,
        secondHeader,
      ]);
      expect(mapping.priceBasis).toBe(basis);
      expect(mappingProblem(mapping)).toBeNull();
      const { candidates, errors } = buildCandidates(
        [['2026-10-05', 'TCS', direction, '10', String(first), String(second)]],
        mapping,
      );
      expect(errors).toEqual([]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ entryPrice, exitPrice });
      expect(computeGrossPnl(candidates[0])).toBe(pnl);
    },
  );

  it('pairs side-specific columns even when sell appears before buy', () => {
    const mapping = guessMapping(['Date', 'Symbol', 'Side', 'Qty', 'Sell Price', 'Buy Price']);
    const { candidates, errors } = buildCandidates(
      [['2026-10-05', 'TCS', 'Short', '10', '110', '100']],
      mapping,
    );
    expect(errors).toEqual([]);
    expect(candidates[0]).toMatchObject({ type: 'Short', entryPrice: 110, exitPrice: 100 });
  });

  it.each([
    [['Entry Price', 'Sell Price']],
    [['Buy Price', 'Exit Price']],
    [['Entry Price', 'Exit Price', 'Buy Price', 'Sell Price']],
    [['Buy Price', 'Buy Avg', 'Sell Price']],
    [['Buy Price', 'Sell Price', 'Sell Avg']],
    [['Buy Price', 'Buy Price', 'Sell Price']],
    [['Entry Price', 'Entry', 'Exit Price']],
    [['Entry Price', 'Exit Price', 'Exit']],
    [['Entry Price', 'Entry Price', 'Exit Price']],
    [['Entry Price', 'Broker Entry Price', 'Exit Price']],
    [['Entry Price', 'Exit Price', 'Broker Exit Price']],
    [['Broker Entry Price', 'Broker Exit Price', 'Buy Price', 'Sell Price']],
  ])('rejects ambiguous mixed or duplicated price columns %j', (priceHeaders) => {
    const mapping = guessMapping(['Date', 'Symbol', 'Side', 'Qty', ...priceHeaders]);
    expect(mapping.priceBasis).toBe('ambiguous');
    const { candidates, errors } = buildCandidates(
      [['2026-10-05', 'TCS', 'Long', '10', ...priceHeaders.map(() => '100')]],
      mapping,
    );
    expect(candidates).toEqual([]);
    expect(errors).toEqual([{ line: 2, reason: expect.stringMatching(/ambiguous/i) }]);
  });

  it('accepts an explicitly selected price pair after automatic mapping reports ambiguity', () => {
    const mapping = guessMapping([
      'Date',
      'Symbol',
      'Side',
      'Qty',
      'Entry Price',
      'Exit Price',
      'Buy Price',
      'Sell Price',
    ]);
    expect(mapping.priceBasis).toBe('ambiguous');
    const selected = { ...mapping, priceBasis: 'buy-sell', entryPrice: 6, exitPrice: 7 };
    const { candidates, errors } = buildCandidates(
      [['2026-10-05', 'TCS', 'Short', '10', '999', '999', '100', '110']],
      selected,
    );
    expect(errors).toEqual([]);
    expect(candidates[0]).toMatchObject({ type: 'Short', entryPrice: 110, exitPrice: 100 });
  });

  it('rejects manually mapping both required prices to a single source column', () => {
    const mapping = guessMapping(['Date', 'Symbol', 'Side', 'Qty', 'Entry Price', 'Exit Price']);
    mapping.exitPrice = mapping.entryPrice;
    const { candidates, errors } = buildCandidates(
      [['2026-10-05', 'TCS', 'Long', '10', '100', '110']],
      mapping,
    );
    expect(candidates).toEqual([]);
    expect(errors).toEqual([{ line: 2, reason: expect.stringMatching(/different column/i) }]);
  });
});
