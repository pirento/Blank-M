import { describe, expect, it } from 'vitest';

import { DEFAULT_CHARGES } from '../../shared/types.js';
import {
  BacktestError,
  DEFAULT_BACKTEST_CONFIG,
  DEFAULT_STRATEGY_PARAMS,
  runBacktest,
} from '../../shared/backtest/engine.js';
import { crossedAbove, ema, rsi, sma } from '../../shared/backtest/indicators.js';

const DAY_MS = 86_400_000;

/** Flat-OHLC candles: close == open == high == low, so fills are unambiguous. */
function candlesFromCloses(closes) {
  return closes.map((close, index) => ({
    time: Date.UTC(2026, 0, 1) + index * DAY_MS,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

/** A deterministic saw-tooth, long enough to trigger several crossovers. */
function sawtooth(length) {
  return Array.from({ length }, (_, i) => 100 + 20 * Math.sin(i / 6));
}

// A crossover needs the fast average to pass *through* the slow one, so the
// fixtures fall first and then turn up: the turn is what creates the cross.
const DECLINE = Array.from({ length: 30 }, (_, i) => 100 - i); // 100 → 71
const RISE = Array.from({ length: 60 }, (_, i) => 71 + i); // 71 → 130
const CRASH = new Array(20).fill(60);

const FAST_CROSS = { ...DEFAULT_STRATEGY_PARAMS, fastPeriod: 3, slowPeriod: 10 };

const NO_CHARGES = { ...DEFAULT_CHARGES, enabled: false };

describe('indicators', () => {
  it('computes a simple moving average with a correct warm-up', () => {
    const values = sma([1, 2, 3, 4, 5], 3);
    expect(values[0]).toBeNull();
    expect(values[1]).toBeNull();
    expect(values[2]).toBe(2);
    expect(values[3]).toBe(3);
    expect(values[4]).toBe(4);
  });

  it('seeds the EMA with a simple average, then smooths', () => {
    const values = ema([1, 2, 3, 4, 5], 3);
    expect(values[1]).toBeNull();
    expect(values[2]).toBe(2);
    // (4 - 2) * (2/4) + 2 = 3
    expect(values[3]).toBe(3);
    expect(values[4]).toBe(4);
  });

  it('returns 100 for RSI when a window has no losses', () => {
    const values = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    expect(values[14]).toBe(100);
  });

  it('keeps RSI within 0 and 100 on noisy input', () => {
    for (const value of rsi(sawtooth(120), 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('detects a crossover only on the bar it happens', () => {
    const fast = [1, 2, 5, 6];
    const slow = [3, 3, 3, 3];
    expect(crossedAbove(fast, slow, 1)).toBe(false);
    expect(crossedAbove(fast, slow, 2)).toBe(true);
    expect(crossedAbove(fast, slow, 3)).toBe(false);
  });
});

describe('runBacktest', () => {
  const candles = candlesFromCloses(sawtooth(200));
  const config = { ...DEFAULT_BACKTEST_CONFIG, charges: NO_CHARGES };

  it('is deterministic — identical inputs give identical results', () => {
    const first = runBacktest(candles, DEFAULT_STRATEGY_PARAMS, config);
    const second = runBacktest(candles, DEFAULT_STRATEGY_PARAMS, config);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.trades).toEqual(first.trades);
  });

  it('responds to a parameter change', () => {
    const slow = runBacktest(candles, { ...DEFAULT_STRATEGY_PARAMS, fastPeriod: 5 }, config);
    const slower = runBacktest(candles, { ...DEFAULT_STRATEGY_PARAMS, fastPeriod: 20 }, config);
    expect(slower.metrics).not.toEqual(slow.metrics);
  });

  it('produces trades on a trending series and accounts for them', () => {
    const result = runBacktest(candles, DEFAULT_STRATEGY_PARAMS, config);
    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    expect(result.metrics.wins + result.metrics.losses).toBeLessThanOrEqual(
      result.metrics.totalTrades,
    );
    // Net profit is the sum of the individual trade results.
    const summed = result.trades.reduce((total, trade) => total + trade.netPnl, 0);
    expect(result.metrics.netProfit).toBeCloseTo(summed, 1);
  });

  it('never trades before the indicator has warmed up', () => {
    const result = runBacktest(candles, DEFAULT_STRATEGY_PARAMS, config);
    const earliest = candles[DEFAULT_STRATEGY_PARAMS.slowPeriod]?.time ?? 0;
    for (const trade of result.trades) {
      expect(trade.entryTime).toBeGreaterThanOrEqual(earliest);
    }
  });

  it('charges reduce net profit versus the same run with charges off', () => {
    const free = runBacktest(candles, DEFAULT_STRATEGY_PARAMS, config);
    const charged = runBacktest(candles, DEFAULT_STRATEGY_PARAMS, {
      ...config,
      charges: DEFAULT_CHARGES,
    });
    expect(charged.metrics.totalCharges).toBeGreaterThan(0);
    expect(charged.metrics.netProfit).toBeLessThan(free.metrics.netProfit);
  });

  it('exits at the stop loss when price falls through it', () => {
    const result = runBacktest(candlesFromCloses([...DECLINE, ...RISE, ...CRASH]), FAST_CROSS, {
      ...config,
      stopLossPercent: 5,
    });
    expect(result.trades.some((trade) => trade.exitReason === 'stop-loss')).toBe(true);
  });

  it('exits at the take profit when price runs through it', () => {
    const result = runBacktest(candlesFromCloses([...DECLINE, ...RISE]), FAST_CROSS, {
      ...config,
      takeProfitPercent: 5,
    });
    expect(result.trades.some((trade) => trade.exitReason === 'take-profit')).toBe(true);
  });

  it('closes any open position at the end of the data', () => {
    // The rise never crosses back down, so the final position cannot exit on a
    // signal and must be force-closed on the last bar.
    const result = runBacktest(candlesFromCloses([...DECLINE, ...RISE]), FAST_CROSS, config);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.at(-1)?.exitReason).toBe('end-of-data');
  });

  it('reports no trades rather than failing when a strategy never triggers', () => {
    const flat = candlesFromCloses(new Array(120).fill(100));
    const result = runBacktest(flat, DEFAULT_STRATEGY_PARAMS, config);
    expect(result.metrics.totalTrades).toBe(0);
    expect(result.metrics.netProfit).toBe(0);
    expect(result.metrics.profitFactor).toBeNull();
  });

  it('takes no trade on a monotonic ramp, because no crossover occurs', () => {
    // The fast average is above the slow one from the moment both exist, so
    // there is never a bar where it crosses *through*. A crossover strategy
    // correctly stays flat here rather than inventing an entry.
    const ramp = candlesFromCloses(Array.from({ length: 80 }, (_, i) => 100 + i));
    expect(runBacktest(ramp, FAST_CROSS, config).metrics.totalTrades).toBe(0);
  });

  it('measures drawdown against the running peak', () => {
    const result = runBacktest(
      candlesFromCloses([...DECLINE, ...RISE, ...CRASH]),
      FAST_CROSS,
      config,
    );
    expect(result.metrics.maxDrawdownPercent).toBeGreaterThan(0);
    expect(result.metrics.maxDrawdownValue).toBeGreaterThan(0);
  });

  it('rejects a fast period that is not shorter than the slow period', () => {
    expect(() =>
      runBacktest(candles, { ...DEFAULT_STRATEGY_PARAMS, fastPeriod: 50, slowPeriod: 50 }, config),
    ).toThrow(BacktestError);
  });

  it('rejects an RSI band where oversold is above overbought', () => {
    expect(() =>
      runBacktest(
        candles,
        { ...DEFAULT_STRATEGY_PARAMS, kind: 'rsi-reversion', rsiOversold: 80, rsiOverbought: 20 },
        config,
      ),
    ).toThrow(BacktestError);
  });

  it('rejects a range too short for the strategy', () => {
    expect(() =>
      runBacktest(candlesFromCloses([1, 2, 3, 4, 5]), DEFAULT_STRATEGY_PARAMS, config),
    ).toThrow(BacktestError);
  });

  it('rejects nonsensical capital and sizing', () => {
    expect(() =>
      runBacktest(candles, DEFAULT_STRATEGY_PARAMS, { ...config, initialCapital: 0 }),
    ).toThrow(BacktestError);
    expect(() =>
      runBacktest(candles, DEFAULT_STRATEGY_PARAMS, { ...config, positionSizePercent: 150 }),
    ).toThrow(BacktestError);
  });
});

describe('backtest financial and candle-order regressions', () => {
  const params = { ...DEFAULT_STRATEGY_PARAMS, kind: 'rsi-reversion', rsiPeriod: 1 };
  const config = { ...DEFAULT_BACKTEST_CONFIG, initialCapital: 1000, charges: NO_CHARGES };

  it.each([
    ['stop-loss', 85, 105, 90],
    ['take-profit', 95, 115, 110],
    ['stop-loss', 80, 120, 90],
  ])('protects an entry on its own bar: %s', (reason, low, high, exitPrice) => {
    const candles = candlesFromCloses([100, 90, 100, 100]);
    candles[2] = { ...candles[2], low, high };
    const result = runBacktest(candles, params, {
      ...config,
      stopLossPercent: 10,
      takeProfitPercent: 10,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryTime: candles[2].time,
      exitTime: candles[2].time,
      entryPrice: 100,
      quantity: 10,
      exitReason: reason,
    });
    expect(result.trades[0].exitPrice).toBeCloseTo(exitPrice, 10);
    expect(result.metrics.exposurePercent).toBe(25);
  });

  it('fills a signal already due at the open before any later stop or target touch', () => {
    const candles = candlesFromCloses([100, 90, 100, 95]);
    candles[3] = { ...candles[3], open: 101, low: 80, high: 120 };
    const result = runBacktest(candles, params, {
      ...config,
      stopLossPercent: 10,
      takeProfitPercent: 10,
    });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      exitReason: 'signal',
      entryPrice: 100,
      exitPrice: 101,
      netPnl: 10,
    });
  });

  it('honours an opening gap through target before a later low touches the stop', () => {
    const candles = candlesFromCloses([100, 90, 100, 95]);
    candles[3] = { ...candles[3], open: 115, low: 80, high: 120 };
    const result = runBacktest(candles, params, {
      ...config,
      stopLossPercent: 10,
      takeProfitPercent: 10,
    });
    expect(result.trades[0]).toMatchObject({ exitReason: 'take-profit', exitPrice: 115 });
  });

  it('fills a gap below stop at the worse opening price and cannot re-enter the same open', () => {
    const candles = candlesFromCloses([100, 90, 89, 85]);
    candles[2] = { ...candles[2], open: 100, high: 100 };
    const result = runBacktest(candles, params, { ...config, stopLossPercent: 15 });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryTime: candles[2].time,
      exitTime: candles[3].time,
      exitReason: 'stop-loss',
      exitPrice: 85,
    });
  });

  it('does not use an intrabar stopped position to buy retroactively at the same open', () => {
    const candles = candlesFromCloses([100, 90, 89, 89]);
    candles[2] = { ...candles[2], open: 100, high: 100 };
    candles[3] = { ...candles[3], open: 90, high: 95, low: 80 };
    const result = runBacktest(candles, params, { ...config, stopLossPercent: 15 });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryTime: candles[2].time,
      exitTime: candles[3].time,
      exitReason: 'stop-loss',
      exitPrice: 85,
    });
  });

  it('reconciles settled paise cash to the sum of displayed trade P&L', () => {
    const candles = candlesFromCloses([2, 1, 2, 1, 2, 1, 2, 1, 2, 1]);
    for (let i = 2; i < candles.length; i++) {
      candles[i] = {
        ...candles[i],
        open: i % 2 === 0 ? 2 : 2.004,
        high: 2.004,
        low: Math.min(candles[i].close, 2),
      };
    }
    const result = runBacktest(candles, params, { ...config, initialCapital: 2 });
    expect(result.trades.length).toBeGreaterThan(2);
    expect(result.trades.every((trade) => trade.netPnl === 0)).toBe(true);
    expect(result.metrics.netProfit).toBe(0);
    expect(result.metrics.finalEquity).toBe(2);
    expect(result.trades[0]?.exitPrice).toBe(2.004);
  });

  it('tracks maximum percentage drawdown independently of a later larger money drawdown', () => {
    // An RSI threshold of 100 suppresses signal exits while this position is held.
    const candles = candlesFromCloses([100, 90, 100, 50, 1000, 900]);
    const result = runBacktest(candles, { ...params, rsiOverbought: 100 }, config);
    expect(result.metrics.maxDrawdownValue).toBe(1000);
    expect(result.metrics.maxDrawdownPercent).toBe(50);
  });

  it.each(['initialCapital', 'positionSizePercent', 'stopLossPercent', 'takeProfitPercent'])(
    'rejects non-finite %s without returning a plausible empty result',
    (field) => {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(() =>
          runBacktest(candlesFromCloses([100, 90, 100, 100]), params, {
            ...config,
            [field]: value,
          }),
        ).toThrow(BacktestError);
      }
    },
  );

  it.each([
    { stopLossPercent: -1 },
    { stopLossPercent: 100 },
    { takeProfitPercent: -1 },
    { initialCapital: Number.MAX_VALUE },
    { charges: { ...NO_CHARGES, sttPercent: NaN } },
    { charges: { ...NO_CHARGES, brokeragePercent: -1 } },
  ])('rejects unsupported financial configuration: %j', (values) => {
    expect(() =>
      runBacktest(candlesFromCloses([100, 90, 100, 100]), params, { ...config, ...values }),
    ).toThrow(BacktestError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid indicator period %s',
    (period) => {
      const candles = candlesFromCloses([100, 90, 100, 100]);
      expect(() => runBacktest(candles, { ...params, rsiPeriod: period }, config)).toThrow(
        BacktestError,
      );
      expect(() => runBacktest(candles, { ...FAST_CROSS, fastPeriod: period }, config)).toThrow(
        BacktestError,
      );
    },
  );

  it.each([
    { open: NaN },
    { high: Infinity },
    { low: -1 },
    { close: 0 },
    { open: 101 },
    { high: 99 },
    { low: 101 },
    { volume: NaN },
    { volume: -1 },
    { time: NaN },
  ])('rejects invalid candles: %j', (values) => {
    const candles = candlesFromCloses([100, 90, 100, 100]);
    candles[2] = { ...candles[2], ...values };
    expect(() => runBacktest(candles, params, config)).toThrow(BacktestError);
  });

  it('rejects duplicate or reversed timestamps instead of inventing a chronological simulation', () => {
    const candles = candlesFromCloses([100, 90, 100, 100]);
    candles[2] = { ...candles[2], time: candles[1].time };
    expect(() => runBacktest(candles, params, config)).toThrow(/timestamps/);
    expect(() => runBacktest(candles.reverse(), params, config)).toThrow(/timestamps/);
  });

  it('rejects unsafe share counts from an extremely small but finite price', () => {
    const candles = candlesFromCloses([2e-20, 1e-20, 2e-20, 2e-20]);
    expect(() => runBacktest(candles, params, config)).toThrow(/quantity/);
  });
});
