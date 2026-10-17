/**
 * A deterministic long-only backtest over real candles.
 *
 * Two properties matter and are covered by tests: the same inputs always
 * produce the same output, and changing a parameter changes the result. The
 * previous implementation could satisfy neither — it returned Math.random().
 *
 * Signals are evaluated on a bar's close and filled at the *next* bar's open.
 * Filling on the signal bar's own close would let the strategy trade on
 * information it could not have had, which is the most common way a backtest
 * flatters itself.
 */
import { computeTradeEconomics } from '../pnl.js';
import { DEFAULT_CHARGES } from '../types.js';
import { crossedAbove, crossedBelow, ema, rsi, sma } from './indicators.js';

export const DEFAULT_STRATEGY_PARAMS = {
  kind: 'sma-cross',
  fastPeriod: 10,
  slowPeriod: 50,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
};

export const DEFAULT_BACKTEST_CONFIG = {
  initialCapital: 100000,
  positionSizePercent: 100,
  stopLossPercent: 0,
  takeProfitPercent: 0,
  charges: DEFAULT_CHARGES,
};

export class BacktestError extends Error {}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function buildSignals(candles, params) {
  const closes = candles.map((candle) => candle.close);
  const entry = new Array(candles.length).fill(false);
  const exit = new Array(candles.length).fill(false);

  if (params.kind === 'rsi-reversion') {
    if (params.rsiOversold >= params.rsiOverbought) {
      throw new BacktestError('The oversold level must be below the overbought level.');
    }
    const series = rsi(closes, params.rsiPeriod);
    for (let i = 0; i < candles.length; i++) {
      const value = series[i];
      if (value == null) continue;
      if (value < params.rsiOversold) entry[i] = true;
      if (value > params.rsiOverbought) exit[i] = true;
    }
    return { entry, exit, warmup: params.rsiPeriod };
  }

  if (params.fastPeriod >= params.slowPeriod) {
    throw new BacktestError('The fast period must be shorter than the slow period.');
  }

  const compute = params.kind === 'ema-cross' ? ema : sma;
  const fast = compute(closes, params.fastPeriod);
  const slow = compute(closes, params.slowPeriod);

  for (let i = 0; i < candles.length; i++) {
    if (crossedAbove(fast, slow, i)) entry[i] = true;
    if (crossedBelow(fast, slow, i)) exit[i] = true;
  }
  return { entry, exit, warmup: params.slowPeriod };
}

const MAX_MONEY = Number.MAX_SAFE_INTEGER / 100;

function assertMoney(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MONEY) {
    throw new BacktestError('The simulation exceeds the supported money range.');
  }
}

function validateInputs(candles, params, config) {
  assertMoney(config.initialCapital);
  if (config.initialCapital < 0.01)
    throw new BacktestError('Initial capital must be at least ₹0.01.');
  if (
    !Number.isFinite(config.positionSizePercent) ||
    config.positionSizePercent <= 0 ||
    config.positionSizePercent > 100
  ) {
    throw new BacktestError('Position size must be greater than 0% and no more than 100%.');
  }
  if (
    !Number.isFinite(config.stopLossPercent) ||
    config.stopLossPercent < 0 ||
    config.stopLossPercent >= 100
  ) {
    throw new BacktestError('Stop loss must be at least 0% and less than 100%; zero disables it.');
  }
  if (!Number.isFinite(config.takeProfitPercent) || config.takeProfitPercent < 0) {
    throw new BacktestError(
      'Take profit must be a finite non-negative percentage; zero disables it.',
    );
  }
  if (
    typeof config.charges.enabled !== 'boolean' ||
    [
      config.charges.brokeragePercent,
      config.charges.brokerageMaxPerOrder,
      config.charges.sttPercent,
      config.charges.exchangeTxnPercent,
      config.charges.sebiPercent,
      config.charges.gstPercent,
      config.charges.stampDutyPercent,
    ].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new BacktestError('Charge estimates must be finite and non-negative.');
  }
  if (!['sma-cross', 'ema-cross', 'rsi-reversion'].includes(params.kind)) {
    throw new BacktestError('Choose a supported backtest strategy.');
  }
  const periods =
    params.kind === 'rsi-reversion' ? [params.rsiPeriod] : [params.fastPeriod, params.slowPeriod];
  if (periods.some((period) => !Number.isSafeInteger(period) || period < 1)) {
    throw new BacktestError('Indicator periods must be positive whole numbers.');
  }
  if (
    params.kind === 'rsi-reversion' &&
    [params.rsiOversold, params.rsiOverbought].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 100,
    )
  ) {
    throw new BacktestError('RSI levels must be between 0 and 100.');
  }
  let previousTime = -Infinity;
  for (const candle of candles) {
    if (
      !candle ||
      !Number.isSafeInteger(candle.time) ||
      Math.abs(candle.time) > 8.64e15 ||
      candle.time <= previousTime
    ) {
      throw new BacktestError(
        'Price history must have valid, unique timestamps in increasing order.',
      );
    }
    if (
      [candle.open, candle.high, candle.low, candle.close].some(
        (value) => !Number.isFinite(value) || value <= 0 || value > MAX_MONEY,
      ) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high < Math.max(candle.open, candle.close) ||
      !Number.isFinite(candle.volume) ||
      candle.volume < 0
    ) {
      throw new BacktestError('Price history contains invalid OHLC prices or volume.');
    }
    if (!Number.isFinite(candle.high * (1 + config.takeProfitPercent / 100))) {
      throw new BacktestError('The target percentage exceeds the supported range.');
    }
    previousTime = candle.time;
  }
}

/**
 * Long-only bar simulation: a signal on one bar's close fills at the next open, the stop is
 * checked before the target, and a position still open is closed at the last close.
 * Returns trades, the per-bar equity curve (₹), warmup bar count and metrics; throws BacktestError.
 */
export function runBacktest(candles, params, config) {
  if (candles.length < 2) {
    throw new BacktestError('Not enough price history to run a backtest.');
  }
  validateInputs(candles, params, config);

  const { entry, exit, warmup } = buildSignals(candles, params);
  if (candles.length <= warmup + 1) {
    throw new BacktestError(
      `This strategy needs at least ${warmup + 2} bars; the selected range has ${candles.length}.`,
    );
  }

  let cash = config.initialCapital;
  let quantity = 0;
  let entryPrice = 0;
  let entryTime = 0;
  let barsInMarket = 0;

  const trades = [];
  const equityCurve = [];

  const closePosition = (exitPrice, exitTime, reason) => {
    const { grossPnl, charges, netPnl } = computeTradeEconomics(
      { type: 'Long', entryPrice, exitPrice, quantity },
      config.charges,
    );
    for (const amount of [grossPnl, charges, netPnl]) assertMoney(amount);
    // Release the original share reserve and settle the same paise-rounded
    // result that the trade record reports. Sub-paise gains must not accumulate
    // invisibly in cash while every reported trade says zero.
    cash = round2(cash + quantity * entryPrice + netPnl);
    assertMoney(cash);
    trades.push({
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      quantity,
      grossPnl: round2(grossPnl),
      charges: round2(charges),
      netPnl: round2(netPnl),
      exitReason: reason,
    });

    quantity = 0;
    entryPrice = 0;
    entryTime = 0;
  };

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    const heldAtOpen = quantity > 0;
    let exposedThisBar = heldAtOpen;
    const stopPrice = () =>
      config.stopLossPercent > 0 ? entryPrice * (1 - config.stopLossPercent / 100) : null;
    const targetPrice = () =>
      config.takeProfitPercent > 0 ? entryPrice * (1 + config.takeProfitPercent / 100) : null;

    // Existing protective orders can gap through their threshold at the open.
    // This known opening price precedes the unknowable intrabar path.
    if (heldAtOpen) {
      const stop = stopPrice();
      const target = targetPrice();
      if (stop !== null && candle.open <= stop) {
        closePosition(candle.open, candle.time, 'stop-loss');
      } else if (target !== null && candle.open >= target) {
        closePosition(candle.open, candle.time, 'take-profit');
      }
    }

    // Previous-close signals fill at this open, before its later high/low.
    // Only a position flat at the start of the bar may enter: a later stop
    // cannot retroactively re-enter at an opening price already passed.
    const signalIndex = i - 1;
    if (signalIndex >= warmup) {
      if (quantity > 0 && exit[signalIndex]) {
        closePosition(candle.open, candle.time, 'signal');
      } else if (!heldAtOpen && quantity === 0 && entry[signalIndex]) {
        const budget = (cash * config.positionSizePercent) / 100;
        const size = Math.floor(budget / candle.open);
        if (size > 0) {
          if (!Number.isSafeInteger(size))
            throw new BacktestError('The simulated quantity exceeds the supported range.');
          // Round-trip charge estimates settle on exit. This is an unlevered
          // share allocation, not a broker buying-power or margin calculation.
          quantity = size;
          entryPrice = candle.open;
          entryTime = candle.time;
          cash -= size * candle.open;
          exposedThisBar = true;
        }
      }
    }

    // Protect new entries on their entry bar too. If both thresholds are
    // touched after the open, OHLC cannot establish their order: stop first.
    if (quantity > 0) {
      const stop = stopPrice();
      const target = targetPrice();
      if (stop !== null && candle.low <= stop) {
        closePosition(stop, candle.time, 'stop-loss');
      } else if (target !== null && candle.high >= target) {
        closePosition(target, candle.time, 'take-profit');
      }
    }
    if (exposedThisBar) barsInMarket++;
    assertMoney(cash + quantity * candle.close);
    equityCurve.push({
      time: candle.time,
      equity: round2(cash + quantity * candle.close),
    });
  }

  const lastCandle = candles[candles.length - 1];
  if (quantity > 0 && lastCandle) {
    closePosition(lastCandle.close, lastCandle.time, 'end-of-data');
    const lastPoint = equityCurve[equityCurve.length - 1];
    if (lastPoint) lastPoint.equity = round2(cash);
  }

  return {
    trades,
    equityCurve,
    warmupBars: warmup,
    metrics: computeMetrics(
      trades,
      equityCurve,
      config.initialCapital,
      barsInMarket,
      candles.length,
    ),
  };
}

function computeMetrics(trades, equityCurve, initialCapital, barsInMarket, totalBars) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);

  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netProfit = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const totalCharges = trades.reduce((sum, trade) => sum + trade.charges, 0);

  let peak = initialCapital;
  let maxDrawdownValue = 0;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const drawdown = peak - point.equity;
    maxDrawdownValue = Math.max(maxDrawdownValue, drawdown);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? (drawdown / peak) * 100 : 0);
  }

  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round2((wins.length / trades.length) * 100) : 0,
    netProfit: round2(netProfit),
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    totalCharges: round2(totalCharges),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    maxDrawdownPercent: round2(maxDrawdownPercent),
    maxDrawdownValue: round2(maxDrawdownValue),
    averageWin: wins.length ? round2(grossProfit / wins.length) : 0,
    averageLoss: losses.length ? round2(grossLoss / losses.length) : 0,
    expectancy: trades.length ? round2(netProfit / trades.length) : 0,
    finalEquity: round2(finalEquity),
    returnPercent: round2(((finalEquity - initialCapital) / initialCapital) * 100),
    sharpeRatio: computeSharpe(equityCurve),
    exposurePercent: totalBars ? round2((barsInMarket / totalBars) * 100) : 0,
  };
}

/** Annualised Sharpe from daily equity returns, assuming a zero risk-free rate. */
function computeSharpe(equityCurve) {
  if (equityCurve.length < 3) return null;

  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const previous = equityCurve[i - 1]?.equity ?? 0;
    const current = equityCurve[i]?.equity ?? 0;
    if (previous > 0) returns.push((current - previous) / previous);
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return null;

  const TRADING_DAYS = 252;
  return round2((mean / stdDev) * Math.sqrt(TRADING_DAYS));
}
