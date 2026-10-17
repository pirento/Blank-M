/**
 * Indicator primitives.
 *
 * Each returns an array the same length as its input, with `null` at every
 * index where there is not yet enough history to compute a value. Keeping the
 * arrays aligned means a strategy can index by bar without offset arithmetic.
 */

export function sma(values, period) {
  if (period <= 0) throw new Error('SMA period must be greater than zero');

  const out = new Array(values.length).fill(null);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average seeded with the SMA of the first `period` values, null before that.
 * Missing values count as 0.
 */
export function ema(values, period) {
  if (period <= 0) throw new Error('EMA period must be greater than zero');

  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const multiplier = 2 / (period + 1);

  // Seed with the SMA of the first `period` bars, the conventional warm-up.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  let previous = seed / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous = ((values[i] ?? 0) - previous) * multiplier + previous;
    out[i] = previous;
  }
  return out;
}

/**
 * Wilder's RSI: the first value uses a simple average of gains and losses over
 * the period, and every subsequent value smooths it. Using a plain rolling mean
 * throughout is a common error that produces a visibly different series.
 */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  out[period] = toRsi(averageGain, averageLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    out[i] = toRsi(averageGain, averageLoss);
  }
  return out;
}

function toRsi(averageGain, averageLoss) {
  // No losses over the window means maximum strength; guards against /0.
  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

/** True when `fast` moved from at-or-below `slow` to strictly above it at `index`. */
export function crossedAbove(fast, slow, index) {
  if (index < 1) return false;
  const fastNow = fast[index];
  const slowNow = slow[index];
  const fastPrev = fast[index - 1];
  const slowPrev = slow[index - 1];
  if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) return false;
  return fastPrev <= slowPrev && fastNow > slowNow;
}

/** True when `fast` moved from at-or-above `slow` to strictly below it at `index`. */
export function crossedBelow(fast, slow, index) {
  if (index < 1) return false;
  const fastNow = fast[index];
  const slowNow = slow[index];
  const fastPrev = fast[index - 1];
  const slowPrev = slow[index - 1];
  if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) return false;
  return fastPrev >= slowPrev && fastNow < slowNow;
}
