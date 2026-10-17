import { describe, expect, it } from 'vitest';
import {
  buildEquityCurve,
  computeCharges,
  computeCurrentBalance,
  computeGrossPnl,
  computeTradeEconomics,
  economicsForTradeEdit,
  parsePositiveNumber,
  sortTradesChronologically,
  summarisePerformance,
  validateTradeInput,
} from '../../shared/pnl.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';

function makeTrade(overrides = {}) {
  return {
    id: 'id',
    date: '2026-01-05',
    symbol: 'RELIANCE',
    type: 'Long',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    grossPnl: 100,
    charges: 0,
    pnl: 100,
    notes: '',
    strategyId: null,
    createdAt: '2026-01-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('computeGrossPnl', () => {
  it('values partial exits exactly instead of at their rounded average', () => {
    const exitLegs = [
      { price: 100.01, quantity: 10000 },
      { price: 100.02, quantity: 20000 },
    ];
    const trade = { type: 'Long', entryPrice: 100, exitPrice: 100.0167, quantity: 30000 };
    expect(computeGrossPnl({ ...trade, exitLegs })).toBe(500);
    expect(computeGrossPnl(trade)).toBe(501);
    // Legs that do not cover the quantity are ignored.
    expect(computeGrossPnl({ ...trade, exitLegs: exitLegs.slice(0, 1) })).toBe(501);
  });

  it('profits when a long exits higher', () => {
    expect(computeGrossPnl({ type: 'Long', entryPrice: 100, exitPrice: 110, quantity: 10 })).toBe(
      100,
    );
  });

  it('loses when a long exits lower', () => {
    expect(computeGrossPnl({ type: 'Long', entryPrice: 110, exitPrice: 100, quantity: 10 })).toBe(
      -100,
    );
  });

  it('profits when a short exits lower', () => {
    expect(computeGrossPnl({ type: 'Short', entryPrice: 110, exitPrice: 100, quantity: 10 })).toBe(
      100,
    );
  });

  it('loses when a short exits higher', () => {
    expect(computeGrossPnl({ type: 'Short', entryPrice: 100, exitPrice: 110, quantity: 10 })).toBe(
      -100,
    );
  });

  it.each([
    [1, 1.0049, 1, 0],
    [1, 1.005, 1, 0.01],
    [1, 1.0051, 1, 0.01],
    [1, 1.0001, 49, 0],
    [1, 1.0001, 50, 0.01],
    [1, 1.0001, 51, 0.01],
    [100.1, 100.4, 5, 1.5],
    [1e-7, 2e-7, 50000, 0.01],
    [1e21, 1.001e21, 1, 1e18],
  ])(
    'settles decimal fills %s → %s × %s symmetrically to %s rupees',
    (entryPrice, exitPrice, quantity, profit) => {
      const loss = profit === 0 ? 0 : -profit;
      expect(computeGrossPnl({ type: 'Long', entryPrice, exitPrice, quantity })).toBe(profit);
      expect(computeGrossPnl({ type: 'Short', entryPrice, exitPrice, quantity })).toBe(loss);
      expect(
        computeGrossPnl({ type: 'Long', entryPrice: exitPrice, exitPrice: entryPrice, quantity }),
      ).toBe(loss);
      expect(
        computeGrossPnl({ type: 'Short', entryPrice: exitPrice, exitPrice: entryPrice, quantity }),
      ).toBe(profit);
    },
  );

  it('keeps zero-quantity and break-even economics at positive zero', () => {
    expect(computeGrossPnl({ type: 'Long', entryPrice: 2, exitPrice: 1, quantity: 0 })).toBe(0);
    expect(
      computeGrossPnl({ type: 'Short', entryPrice: 1.005, exitPrice: 1.005, quantity: 1 }),
    ).toBe(0);
    expect(
      computeGrossPnl({ type: 'Long', entryPrice: 5e-324, exitPrice: 1e-323, quantity: 1 }),
    ).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity])(
    'does not turn invalid input %s into valid P&L',
    (invalid) => {
      for (const field of ['entryPrice', 'exitPrice', 'quantity']) {
        expect(
          computeGrossPnl({
            type: 'Long',
            entryPrice: 1,
            exitPrice: 2,
            quantity: 1,
            [field]: invalid,
          }),
        ).toBeNaN();
      }
    },
  );
});

describe('computeCharges', () => {
  const zeroRates = {
    enabled: true,
    brokeragePercent: 0,
    brokerageMaxPerOrder: 20,
    sttPercent: 0,
    exchangeTxnPercent: 0,
    sebiPercent: 0,
    gstPercent: 0,
    stampDutyPercent: 0,
  };
  // Hand-computed for buy 100 @ 1000 (₹100,000) and sell 100 @ 1010 (₹101,000):
  //   brokerage  = min(30, 20) + min(30.30, 20)        = 40
  //   STT        = 101,000 * 0.025%                    = 25.25
  //   exchange   = 201,000 * 0.00297%                  = 5.9697  -> 5.97
  //   SEBI       = 201,000 * 0.0001%                   = 0.201   -> 0.20
  //   GST        = (40 + 5.9697 + 0.201) * 18%         = 8.3105  -> 8.31
  //   stamp duty = 100,000 * 0.003%                    = 3
  //   total                                            = 82.73
  const trade = { type: 'Long', entryPrice: 1000, exitPrice: 1010, quantity: 100 };

  it('matches a hand-computed breakdown', () => {
    const breakdown = computeCharges(trade, DEFAULT_CHARGES);
    expect(breakdown.brokerage).toBe(40);
    expect(breakdown.stt).toBe(25.25);
    expect(breakdown.exchangeTxn).toBe(5.97);
    expect(breakdown.sebi).toBe(0.2);
    expect(breakdown.gst).toBe(8.31);
    expect(breakdown.stampDuty).toBe(3);
    expect(breakdown.total).toBe(82.73);
  });

  it('caps brokerage per order', () => {
    const small = computeCharges(
      { type: 'Long', entryPrice: 10, exitPrice: 11, quantity: 10 },
      DEFAULT_CHARGES,
    );
    // 0.03% of ₹100 is 3 paise, far below the ₹20 cap, so the percentage applies.
    expect(small.brokerage).toBeCloseTo(0.06, 2);
  });

  it('applies the brokerage cap once per order on each side', () => {
    // ₹1,00,000 each way: 0.03% is ₹30, above the ₹20 cap.
    const base = { type: 'Long', entryPrice: 1000, exitPrice: 1000, quantity: 100 };
    expect(computeCharges(base, DEFAULT_CHARGES).brokerage).toBe(40);
    // Three entry orders may pay up to three caps; the 0.03% (₹30) is below ₹60.
    expect(computeCharges({ ...base, entryOrders: 3 }, DEFAULT_CHARGES).brokerage).toBe(50);
    // A short's entry is its sell side; the result is symmetric.
    expect(
      computeCharges({ ...base, type: 'Short', entryOrders: 1, exitOrders: 2 }, DEFAULT_CHARGES)
        .brokerage,
    ).toBe(50);
    // Nonsense counts fall back to one order.
    expect(computeCharges({ ...base, exitOrders: 0 }, DEFAULT_CHARGES).brokerage).toBe(40);
  });

  it('returns zero for every charge when disabled', () => {
    const disabled = { ...DEFAULT_CHARGES, enabled: false };
    expect(computeCharges(trade, disabled).total).toBe(0);
  });

  it('bases STT on the sell leg and stamp duty on the buy leg, whichever came first', () => {
    // A short sells at entry (110) and buys back at exit (100), so its STT base
    // is the entry price and its stamp-duty base is the exit price — the mirror
    // image of a long with the same two prices.
    const short = computeCharges({ type: 'Short', entryPrice: 110, exitPrice: 100, quantity: 100 });
    expect(short.stt).toBeCloseTo(2.75, 2); // 11,000 * 0.025%
    expect(short.stampDuty).toBeCloseTo(0.3, 2); // 10,000 * 0.003%

    const long = computeCharges({ type: 'Long', entryPrice: 100, exitPrice: 110, quantity: 100 });
    expect(long.stt).toBeCloseTo(2.75, 2); // sells at 110
    expect(long.stampDuty).toBeCloseTo(0.3, 2); // buys at 100
  });

  it('settles a fractional percentage fee at an exact half paise', () => {
    // ₹100.50 × 1% = ₹1.005, which settles to ₹1.01, not ₹1.00.
    const breakdown = computeCharges(
      { type: 'Long', entryPrice: 100, exitPrice: 100.5, quantity: 1 },
      { ...zeroRates, sttPercent: 1 },
    );
    expect(breakdown.stt).toBe(1.01);
    expect(breakdown.total).toBe(1.01);
  });

  it('sums exact sub-paise charges before settling the total', () => {
    const breakdown = computeCharges(
      { type: 'Long', entryPrice: 1, exitPrice: 1, quantity: 1 },
      { ...zeroRates, sttPercent: 0.4, stampDutyPercent: 0.4 },
    );
    expect(breakdown.stt).toBe(0);
    expect(breakdown.stampDuty).toBe(0);
    expect(breakdown.total).toBe(0.01); // ₹0.004 + ₹0.004 = ₹0.008.
  });

  it('calculates GST from exact fees before displaying their rounded breakdown', () => {
    const breakdown = computeCharges(
      { type: 'Long', entryPrice: 1, exitPrice: 1, quantity: 1 },
      { ...zeroRates, brokeragePercent: 0.125, exchangeTxnPercent: 0.125, gstPercent: 100 },
    );
    expect(breakdown.brokerage).toBe(0); // Two legs × ₹0.00125 = ₹0.0025.
    expect(breakdown.exchangeTxn).toBe(0); // ₹2 turnover × 0.125% = ₹0.0025.
    expect(breakdown.gst).toBe(0.01); // (₹0.0025 + ₹0.0025) × 100% = ₹0.005.
    expect(breakdown.total).toBe(0.01);
  });

  it('applies each order cap before summing or settling brokerage', () => {
    const breakdown = computeCharges(
      { type: 'Long', entryPrice: 1, exitPrice: 1, quantity: 1 },
      { ...zeroRates, brokeragePercent: 1, brokerageMaxPerOrder: 0.004 },
    );
    expect(breakdown.brokerage).toBe(0.01);
    expect(breakdown.total).toBe(0.01);
  });

  it('supports scientific fee rates and retains zero quantity without charges', () => {
    const config = { ...zeroRates, sttPercent: 5e-7 };
    expect(
      computeCharges({ type: 'Long', entryPrice: 1, exitPrice: 1e6, quantity: 1 }, config).total,
    ).toBe(0.01);
    expect(
      computeCharges({ type: 'Long', entryPrice: 1, exitPrice: 2, quantity: 0 }, DEFAULT_CHARGES)
        .total,
    ).toBe(0);
  });

  it('propagates invalid enabled economics but retains the disabled-fees contract', () => {
    const input = { type: 'Long', entryPrice: NaN, exitPrice: 1, quantity: 1 };
    expect(computeCharges(input).total).toBeNaN();
    expect(computeCharges(trade, { ...DEFAULT_CHARGES, gstPercent: Infinity }).total).toBeNaN();
    expect(Object.values(computeCharges(input, { ...DEFAULT_CHARGES, enabled: false }))).toEqual(
      Array(7).fill(0),
    );
  });
});

describe('computeTradeEconomics', () => {
  it('subtracts charges from gross to give net', () => {
    const result = computeTradeEconomics({
      type: 'Long',
      entryPrice: 1000,
      exitPrice: 1010,
      quantity: 100,
    });
    expect(result.grossPnl).toBe(1000);
    expect(result.charges).toBe(82.73);
    expect(result.netPnl).toBe(917.27);
  });

  it('turns a small gross profit into a net loss once charges bite', () => {
    const result = computeTradeEconomics({
      type: 'Long',
      entryPrice: 1000,
      exitPrice: 1000.2,
      quantity: 100,
    });
    expect(result.grossPnl).toBe(20);
    expect(result.netPnl).toBeLessThan(0);
  });

  it('subtracts the settled fee from settled gross P&L using exact paise', () => {
    const result = computeTradeEconomics(
      { type: 'Long', entryPrice: 99.995, exitPrice: 100.5, quantity: 1 },
      {
        ...DEFAULT_CHARGES,
        brokeragePercent: 0,
        sttPercent: 1,
        exchangeTxnPercent: 0,
        sebiPercent: 0,
        gstPercent: 0,
        stampDutyPercent: 0,
      },
    );
    expect(result).toMatchObject({ grossPnl: 0.51, charges: 1.01, netPnl: -0.5 });
  });

  it('preserves historical half-paise economics on metadata-only edits', () => {
    const original = makeTrade({
      entryPrice: 1,
      exitPrice: 1.005,
      quantity: 1,
      grossPnl: 0,
      charges: 0,
      pnl: 0,
    });
    const config = { ...DEFAULT_CHARGES, enabled: false };
    const editedMetadata = { ...original, notes: 'Reviewed' };
    expect(economicsForTradeEdit(original, editedMetadata, config)).toEqual({
      grossPnl: 0,
      charges: 0,
      netPnl: 0,
    });
    expect(economicsForTradeEdit(undefined, original, config)).toMatchObject({
      grossPnl: 0.01,
      charges: 0,
      netPnl: 0.01,
    });
  });
});

describe('parsePositiveNumber', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['abc', null],
    ['0', null],
    ['-5', null],
    ['NaN', null],
    ['Infinity', null],
    ['12.5', 12.5],
    [' 7 ', 7],
  ])('parses %j as %j', (input, expected) => {
    expect(parsePositiveNumber(input)).toBe(expected);
  });
});

describe('validateTradeInput', () => {
  const valid = {
    symbol: 'RELIANCE',
    date: '2026-01-05',
    entryPrice: '100',
    exitPrice: '110',
    quantity: '10',
  };

  it('accepts a well-formed trade', () => {
    expect(validateTradeInput(valid)).toEqual({});
  });

  it('rejects the empty prices that used to produce NaN P&L', () => {
    const errors = validateTradeInput({ ...valid, entryPrice: '', exitPrice: 'abc' });
    expect(errors.entryPrice).toBeDefined();
    expect(errors.exitPrice).toBeDefined();
  });

  it('rejects zero and negative quantities', () => {
    expect(validateTradeInput({ ...valid, quantity: '0' }).quantity).toBeDefined();
    expect(validateTradeInput({ ...valid, quantity: '-3' }).quantity).toBeDefined();
  });

  it('preserves four-decimal fills but rejects prices the database would silently round', () => {
    expect(
      validateTradeInput({ ...valid, entryPrice: '100.0123', exitPrice: '100.1234000' }),
    ).toEqual({});
    const errors = validateTradeInput({
      ...valid,
      entryPrice: '100.00001',
      exitPrice: '100.00002',
      quantity: '1000000',
    });
    expect(errors.entryPrice).toMatch(/four decimal/);
    expect(errors.exitPrice).toMatch(/four decimal/);
    expect(validateTradeInput({ ...valid, entryPrice: '0.00001' }).entryPrice).toBeDefined();
    expect(validateTradeInput({ ...valid, entryPrice: '12345678901234.1234' }).entryPrice).toMatch(
      /losing decimal precision/,
    );
    expect(validateTradeInput({ ...valid, entryPrice: '000100.012300' })).toEqual({});
  });

  it('rejects impossible dates, fractional shares and database numeric overflow', () => {
    expect(validateTradeInput({ ...valid, date: '2026-02-30' }).date).toBeDefined();
    expect(validateTradeInput({ ...valid, date: '2024-02-29' })).toEqual({});
    expect(validateTradeInput({ ...valid, quantity: '1.00001' }).quantity).toMatch(/whole number/);
    expect(validateTradeInput({ ...valid, quantity: '100000000000000' }).quantity).toMatch(/range/);
    expect(validateTradeInput({ ...valid, entryPrice: '100000000000000' }).entryPrice).toMatch(
      /range/,
    );
  });
});

describe('summarisePerformance', () => {
  const trades = [
    makeTrade({ id: '1', pnl: 100, grossPnl: 120, charges: 20 }),
    makeTrade({ id: '2', pnl: -50, grossPnl: -30, charges: 20 }),
    makeTrade({ id: '3', pnl: 200, grossPnl: 220, charges: 20 }),
  ];

  it('computes win rate and profit factor from net P&L', () => {
    const summary = summarisePerformance(trades);
    expect(summary.totalTrades).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBeCloseTo(66.67, 1);
    expect(summary.netPnl).toBe(250);
    expect(summary.charges).toBe(60);
    expect(summary.profitFactor).toBe(6);
  });

  it('reports null profit factor rather than Infinity when nothing lost', () => {
    expect(summarisePerformance([makeTrade({ pnl: 10 })]).profitFactor).toBeNull();
  });

  it('handles an empty set without dividing by zero', () => {
    const summary = summarisePerformance([]);
    expect(summary.winRate).toBe(0);
    expect(summary.expectancy).toBe(0);
    expect(summary.profitFactor).toBeNull();
  });
});

describe('sortTradesChronologically', () => {
  it('orders by trade date, not insertion order', () => {
    const backdated = makeTrade({ id: 'old', date: '2026-01-01' });
    const recent = makeTrade({ id: 'new', date: '2026-03-01' });
    // Insertion order here is newest-first, as the store returns it.
    const sorted = sortTradesChronologically([recent, backdated]);
    expect(sorted.map((trade) => trade.id)).toEqual(['old', 'new']);
  });
});

describe('balance derivation', () => {
  it('adds net P&L to the opening balance', () => {
    const trades = [makeTrade({ id: '1', pnl: 500 }), makeTrade({ id: '2', pnl: -200 })];
    expect(computeCurrentBalance(100000, trades)).toBe(100300);
  });

  it('builds an equity curve that starts at the opening balance', () => {
    const curve = buildEquityCurve(1000, [
      makeTrade({ id: '1', date: '2026-01-02', pnl: 100 }),
      makeTrade({ id: '2', date: '2026-01-01', pnl: -50 }),
    ]);
    expect(curve[0]?.balance).toBe(1000);
    // The backdated trade is applied first.
    expect(curve[1]?.balance).toBe(950);
    expect(curve[2]?.balance).toBe(1050);
  });
});
