import { describe, expect, it } from 'vitest';
import {
  blackScholes,
  legGreeks,
  legPayoff,
  netPremium,
  normCdf,
  payoffCurve,
  payoffSummary,
  presetLegs,
  strategyGreeks,
  validateStrategy,
} from '../../shared/options.js';

const textbook = { spot: 100, strike: 100, years: 1, rate: 0.05, vol: 0.2 };
const leg = (fields) => ({
  side: 'buy',
  kind: 'call',
  strike: 100,
  premium: 0,
  lots: 1,
  lotSize: 1,
  ...fields,
});

describe('normal distribution', () => {
  it('matches standard table values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(normCdf(3)).toBeCloseTo(0.9986501, 6);
    expect(normCdf(1.5) + normCdf(-1.5)).toBeCloseTo(1, 12);
  });
});

describe('Black-Scholes', () => {
  it('prices the textbook at-the-money call and put', () => {
    const call = blackScholes({ ...textbook, kind: 'call' });
    const put = blackScholes({ ...textbook, kind: 'put' });
    expect(call.price).toBeCloseTo(10.4506, 4);
    expect(put.price).toBeCloseTo(5.5735, 4);
    expect(call.delta).toBeCloseTo(0.6368, 4);
    expect(put.delta).toBeCloseTo(-0.3632, 4);
    expect(call.gamma).toBeCloseTo(0.018762, 5);
    expect(put.gamma).toBeCloseTo(call.gamma, 10);
    expect(call.vega).toBeCloseTo(0.37524, 4); // per 1% volatility
    expect(call.theta * 365).toBeCloseTo(-6.414, 3); // per year
    expect(put.theta * 365).toBeCloseTo(-1.6579, 3);
  });

  it('matches Hull’s worked example (S 42, K 40, r 10%, σ 20%, 6 months)', () => {
    const market = { spot: 42, strike: 40, years: 0.5, rate: 0.1, vol: 0.2 };
    expect(blackScholes({ ...market, kind: 'call' }).price).toBeCloseTo(4.7594, 3);
    expect(blackScholes({ ...market, kind: 'put' }).price).toBeCloseTo(0.8086, 3);
  });

  it('keeps put-call parity and sensible deltas across strikes', () => {
    for (const strike of [70, 90, 100, 115, 140]) {
      const market = { ...textbook, strike, years: 0.3, vol: 0.35 };
      const call = blackScholes({ ...market, kind: 'call' });
      const put = blackScholes({ ...market, kind: 'put' });
      expect(call.price - put.price).toBeCloseTo(100 - strike * Math.exp(-0.05 * 0.3), 6);
      expect(call.delta).toBeGreaterThan(0);
      expect(call.delta).toBeLessThan(1);
      expect(put.delta).toBeGreaterThan(-1);
      expect(put.delta).toBeLessThan(0);
      expect(call.delta - put.delta).toBeCloseTo(1, 9);
      expect(call.gamma).toBeGreaterThan(0);
      expect(call.vega).toBeGreaterThan(0);
    }
  });

  it('falls back to intrinsic value at expiry', () => {
    expect(blackScholes({ ...textbook, years: 0, kind: 'call', spot: 104 })).toEqual({
      price: 4,
      delta: 1,
      gamma: 0,
      theta: 0,
      vega: 0,
    });
    expect(blackScholes({ ...textbook, years: 0, kind: 'put', spot: 104 }).price).toBe(0);
  });
});

describe('legs', () => {
  it('pays out at expiry by side and kind', () => {
    expect(legPayoff(leg({ premium: 5 }), 120)).toBe(15);
    expect(legPayoff(leg({ premium: 5 }), 80)).toBe(-5);
    expect(
      legPayoff(leg({ kind: 'put', side: 'sell', premium: 5, lots: 2, lotSize: 75 }), 90),
    ).toBe(-750);
    expect(legPayoff(leg({ kind: 'future', premium: 100, lotSize: 75 }), 110)).toBe(750);
  });

  it('sizes Greeks by lots × lot size, negative for a sold leg', () => {
    const market = { spot: 100, days: 365, iv: 20, rate: 5 };
    const sold = legGreeks(leg({ side: 'sell', lots: 2, lotSize: 75, premium: 10 }), market);
    expect(sold.delta).toBeCloseTo(-0.6368 * 150, 1);
    expect(sold.price).toBeCloseTo(10.4506, 4);
    expect(sold.pnl).toBeCloseTo(-0.4506 * 150, 1);
    expect(legGreeks(leg({ kind: 'future', premium: 100, lotSize: 75 }), market)).toMatchObject({
      delta: 75,
      gamma: 0,
      pnl: 0,
    });
    // A straddle bought at fair value starts flat and gains gamma, loses theta.
    const straddle = [leg({ premium: 10.4506 }), leg({ kind: 'put', premium: 5.5735 })];
    const total = strategyGreeks(straddle, market);
    expect(total.pnl).toBeCloseTo(0, 3);
    expect(total.delta).toBeCloseTo(0.2736, 3);
    expect(total.gamma).toBeGreaterThan(0);
    expect(total.theta).toBeLessThan(0);
  });
});

describe('strategy payoff', () => {
  it('samples the expiry and today curves over the range', () => {
    const curve = payoffCurve(
      [leg({ premium: 5 })],
      { spot: 100, days: 30, iv: 20, rate: 6.5 },
      {
        from: 85,
        to: 115,
        points: 7,
      },
    );
    expect(curve.map((point) => point.price)).toEqual([85, 90, 95, 100, 105, 110, 115]);
    expect(curve.map((point) => point.expiry)).toEqual([-5, -5, -5, -5, 0, 5, 10]);
    // Before expiry an option is worth at least its intrinsic value.
    for (const point of curve) expect(point.today).toBeGreaterThanOrEqual(point.expiry - 1e-9);
  });

  it('finds a long call’s breakeven and unlimited profit', () => {
    const summary = payoffSummary([leg({ premium: 5, lots: 1, lotSize: 75 })]);
    expect(summary).toEqual({ breakevens: [105], maxProfit: Infinity, maxLoss: -375 });
  });

  it('finds both breakevens and unlimited loss of a short straddle', () => {
    const legs = [
      leg({ side: 'sell', premium: 120, strike: 24000, lotSize: 75 }),
      leg({ side: 'sell', kind: 'put', premium: 110, strike: 24000, lotSize: 75 }),
    ];
    expect(payoffSummary(legs)).toEqual({
      breakevens: [23770, 24230],
      maxProfit: 17250,
      maxLoss: -Infinity,
    });
    expect(netPremium(legs)).toBe(17250);
  });

  it('bounds a short put by a zero price, not by the chart range', () => {
    const summary = payoffSummary([leg({ side: 'sell', kind: 'put', premium: 4, strike: 100 })]);
    expect(summary).toEqual({ breakevens: [96], maxProfit: 4, maxLoss: -96 });
  });

  it('bounds both sides of an iron condor', () => {
    const legs = [
      leg({ kind: 'put', strike: 90, premium: 1 }),
      leg({ kind: 'put', strike: 95, premium: 3, side: 'sell' }),
      leg({ strike: 105, premium: 3, side: 'sell' }),
      leg({ strike: 110, premium: 1 }),
    ];
    expect(netPremium(legs)).toBe(4);
    expect(payoffSummary(legs)).toEqual({ breakevens: [91, 109], maxProfit: 4, maxLoss: -1 });
  });

  it('handles a lone future and a breakeven exactly on a strike', () => {
    expect(payoffSummary([leg({ kind: 'future', premium: 250 })])).toEqual({
      breakevens: [250],
      maxProfit: Infinity,
      maxLoss: -250,
    });
    const spread = [
      leg({ strike: 100, premium: 5 }),
      leg({ strike: 105, premium: 0, side: 'sell' }),
    ];
    expect(payoffSummary(spread)).toEqual({ breakevens: [105], maxProfit: 0, maxLoss: -5 });
  });
});

describe('presets and validation', () => {
  const market = { spot: 24012, days: 7, iv: 14, rate: 6.5 };

  it('builds presets on 50-point strikes with fair premiums', () => {
    expect(presetLegs('long-call', market)).toEqual([
      expect.objectContaining({ side: 'buy', kind: 'call', strike: 24000, lots: 1, lotSize: 65 }),
    ]);
    const condor = presetLegs('iron-condor', market);
    expect(condor.map((row) => `${row.side} ${row.kind} ${row.strike}`)).toEqual([
      'buy put 23500',
      'sell put 23750',
      'sell call 24250',
      'buy call 24500',
    ]);
    for (const row of condor) {
      expect(row.premium).toBeGreaterThan(0);
      expect(Math.round(row.premium * 20)).toBeCloseTo(row.premium * 20, 9);
    }
    expect(presetLegs('short-straddle', market)).toHaveLength(2);
    expect(presetLegs('bull-call-spread', market)[1].strike).toBe(24250);
    // A cheap underlying gets small strike steps: positive strikes and real premiums.
    const cheap = presetLegs('iron-condor', { ...market, spot: 20 });
    expect(cheap.map((row) => row.strike)).toEqual([18, 19, 21, 22]);
    for (const row of cheap) expect(Number.isFinite(row.premium)).toBe(true);
  });

  it('parses valid input and explains each problem', () => {
    const ok = validateStrategy({
      ...market,
      spot: '24012',
      legs: [
        { side: 'sell', kind: 'put', strike: '24000', premium: '80', lots: '2', lotSize: '75' },
      ],
    });
    expect(ok.errors).toEqual({});
    expect(ok.legs[0]).toEqual({
      side: 'sell',
      kind: 'put',
      strike: 24000,
      premium: 80,
      lots: 2,
      lotSize: 75,
    });
    const bad = validateStrategy({
      spot: '',
      days: -1,
      iv: 0,
      rate: 6.5,
      legs: [{ kind: 'call', strike: 0, premium: -1, lots: 1.5, lotSize: 0 }],
    });
    expect(Object.keys(bad.errors).sort()).toEqual([
      'days',
      'iv',
      'legs.0.lotSize',
      'legs.0.lots',
      'legs.0.premium',
      'legs.0.strike',
      'spot',
    ]);
    expect(bad.legs).toBeUndefined();
    expect(validateStrategy({ ...market, legs: [] }).errors.legs).toBe('Add at least one leg.');
    expect(
      validateStrategy({
        ...market,
        legs: Array(7).fill({ strike: 1, premium: 1, lots: 1, lotSize: 1 }),
      }).errors.legs,
    ).toBe('Use at most 6 legs.');
  });
});
