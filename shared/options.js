/**
 * F&O options maths for the payoff tool: Black-Scholes prices and Greeks
 * (European, no dividends), leg and strategy payoff at expiry and today,
 * breakevens, max profit/loss and the strategy presets. Pure functions; the
 * browser page only draws what these return.
 */

export const MAX_LEGS = 6;
export const STRIKE_STEP = 50;
export const DEFAULT_LOT_SIZE = 75;
export const DEFAULT_RATE = 6.5;
const DAYS_PER_YEAR = 365;

const round2 = (value) => Math.round(value * 100) / 100;

/** Standard normal density. */
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/**
 * Standard normal cumulative distribution, Abramowitz & Stegun 26.2.17
 * (absolute error below 7.5e-8, far finer than a paisa on any premium).
 */
export function normCdf(x) {
  if (x < 0) return 1 - normCdf(-x);
  const t = 1 / (1 + 0.2316419 * x);
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - normPdf(x) * poly;
}

/**
 * Black-Scholes value and Greeks of one call or put. `years` is time to
 * expiry, `rate` and `vol` are decimals (0.065, 0.2). Theta is per calendar
 * day and vega per 1 percentage point of volatility. At expiry (years 0) the
 * value is intrinsic and delta a step, with no gamma, theta or vega.
 */
export function blackScholes({ kind, spot, strike, years, rate, vol }) {
  const call = kind === 'call';
  if (years <= 0 || vol <= 0) {
    const intrinsic = Math.max(call ? spot - strike : strike - spot, 0);
    const inMoney = call ? spot > strike : spot < strike;
    return { price: intrinsic, delta: inMoney ? (call ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const root = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * years) / (vol * root);
  const d2 = d1 - vol * root;
  const discount = strike * Math.exp(-rate * years);
  const decay = (-spot * normPdf(d1) * vol) / (2 * root);
  return {
    price: call
      ? spot * normCdf(d1) - discount * normCdf(d2)
      : discount * normCdf(-d2) - spot * normCdf(-d1),
    delta: call ? normCdf(d1) : normCdf(d1) - 1,
    gamma: normPdf(d1) / (spot * vol * root),
    theta:
      (call ? decay - rate * discount * normCdf(d2) : decay + rate * discount * normCdf(-d2)) /
      DAYS_PER_YEAR,
    vega: (spot * normPdf(d1) * root) / 100,
  };
}

/** Signed quantity of a leg: lots × lot size, negative when sold. */
export const legQuantity = (leg) => (leg.side === 'sell' ? -1 : 1) * leg.lots * leg.lotSize;

/** Rupee P&L of one leg at expiry if the underlying settles at `price`. */
export function legPayoff(leg, price) {
  const value =
    leg.kind === 'future'
      ? price
      : Math.max(leg.kind === 'call' ? price - leg.strike : leg.strike - price, 0);
  return (value - leg.premium) * legQuantity(leg);
}

/**
 * Value and position Greeks of one leg today (`market`: { spot, days, iv, rate }
 * with iv and rate in percent). Greeks are already multiplied by the signed
 * quantity, so they add up across legs.
 */
export function legGreeks(leg, market) {
  const quantity = legQuantity(leg);
  // shortcut: a future is valued at spot (no cost of carry); fine for near-month index futures.
  const unit =
    leg.kind === 'future'
      ? { price: market.spot, delta: 1, gamma: 0, theta: 0, vega: 0 }
      : blackScholes({
          kind: leg.kind,
          spot: market.spot,
          strike: leg.strike,
          years: market.days / DAYS_PER_YEAR,
          rate: market.rate / 100,
          vol: market.iv / 100,
        });
  return {
    price: unit.price,
    pnl: (unit.price - leg.premium) * quantity,
    delta: unit.delta * quantity,
    gamma: unit.gamma * quantity,
    theta: unit.theta * quantity,
    vega: unit.vega * quantity,
  };
}

/** Sum of every leg's position Greeks and today's P&L. */
export function strategyGreeks(legs, market) {
  const total = { pnl: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const leg of legs) {
    const greeks = legGreeks(leg, market);
    for (const key of Object.keys(total)) total[key] += greeks[key];
  }
  return total;
}

/**
 * P&L at expiry and today across `points` prices from `from` to `to`:
 * [{ price, expiry, today }].
 */
export function payoffCurve(legs, market, { from, to, points = 201 }) {
  return Array.from({ length: points }, (_, index) => {
    const price = from + ((to - from) * index) / (points - 1);
    return {
      price,
      expiry: legs.reduce((sum, leg) => sum + legPayoff(leg, price), 0),
      today: strategyGreeks(legs, { ...market, spot: price }).pnl,
    };
  });
}

/** Net premium cash flow when opening: positive = received, negative = paid. Futures carry none. */
export const netPremium = (legs) =>
  round2(
    legs
      .filter((leg) => leg.kind !== 'future')
      .reduce((sum, leg) => sum - leg.premium * legQuantity(leg), 0),
  );

/**
 * Expiry payoff summary: breakevens, max profit and max loss. The payoff is
 * straight between strikes, so checking every strike (and price 0) and the
 * slope beyond the highest strike is exact: a rising tail means unlimited
 * profit, a falling one unlimited loss. Below zero the price cannot go, so
 * the left side is always bounded. Infinity / -Infinity mark "Unlimited".
 */
export function payoffSummary(legs) {
  const at = (price) => legs.reduce((sum, leg) => sum + legPayoff(leg, price), 0);
  const kinks = [
    0,
    ...new Set(legs.filter((leg) => leg.kind !== 'future').map((leg) => leg.strike)),
  ].sort((left, right) => left - right);
  const values = kinks.map(at);
  // Beyond the top strike every call and future moves one rupee per rupee; puts are worthless.
  const tailSlope = legs
    .filter((leg) => leg.kind !== 'put')
    .reduce((sum, leg) => sum + legQuantity(leg), 0);
  const breakevens = [];
  const close = (value) => Math.abs(value) < 1e-9;
  for (let index = 0; index < kinks.length; index += 1) {
    const [price, value] = [kinks[index], values[index]];
    if (close(value) && index > 0) {
      breakevens.push(price);
      continue;
    }
    const nextPrice = kinks[index + 1];
    const next = index + 1 < kinks.length ? values[index + 1] : null;
    if (next !== null && !close(next) && !close(value) && Math.sign(next) !== Math.sign(value)) {
      breakevens.push(price + ((nextPrice - price) * value) / (value - next));
    } else if (
      next === null &&
      !close(value) &&
      tailSlope &&
      Math.sign(tailSlope) !== Math.sign(value)
    ) {
      breakevens.push(price - value / tailSlope);
    }
  }
  return {
    breakevens: breakevens.map(round2),
    maxProfit: tailSlope > 0 ? Infinity : round2(Math.max(...values)),
    maxLoss: tailSlope < 0 ? -Infinity : round2(Math.min(...values)),
  };
}

/** Round a price to the nearest strike step. */
export const roundStrike = (price, step = STRIKE_STEP) => Math.round(price / step) * step;

export const PRESETS = {
  'long-call': 'Long call',
  'bull-call-spread': 'Bull call spread',
  'short-straddle': 'Short straddle',
  'iron-condor': 'Iron condor',
};

/**
 * Legs for a preset around the at-the-money strike. Wings are about 1% of
 * spot (at least one strike step) and premiums are today's Black-Scholes
 * values rounded to the 5-paise tick, so the preset starts at a fair price.
 */
export function presetLegs(name, market, lotSize = DEFAULT_LOT_SIZE) {
  const atm = roundStrike(market.spot);
  const wing = Math.max(STRIKE_STEP, roundStrike(market.spot * 0.01));
  const leg = (side, kind, strike) => ({
    side,
    kind,
    strike,
    premium:
      Math.round(
        legGreeks({ side, kind, strike, premium: 0, lots: 1, lotSize: 1 }, market).price * 20,
      ) / 20,
    lots: 1,
    lotSize,
  });
  const shapes = {
    'long-call': [['buy', 'call', atm]],
    'bull-call-spread': [
      ['buy', 'call', atm],
      ['sell', 'call', atm + wing],
    ],
    'short-straddle': [
      ['sell', 'call', atm],
      ['sell', 'put', atm],
    ],
    'iron-condor': [
      ['buy', 'put', atm - 2 * wing],
      ['sell', 'put', atm - wing],
      ['sell', 'call', atm + wing],
      ['buy', 'call', atm + 2 * wing],
    ],
  };
  return (shapes[name] ?? []).map((shape) => leg(...shape));
}

const number = (value) =>
  value === '' || value === null || value === undefined ? NaN : Number(value);

/**
 * Check the form values (strings or numbers). Returns { errors, market, legs }:
 * `errors` maps a field key ('spot', 'legs.0.strike', …) to a message for the
 * member; market and legs hold parsed numbers only when there are no errors.
 */
export function validateStrategy(input) {
  const errors = {};
  const check = (key, value, test, message) => {
    if (!Number.isFinite(value) || !test(value)) errors[key] = message;
    return value;
  };
  const market = {
    spot: check('spot', number(input.spot), (v) => v > 0, 'Enter the underlying price above 0.'),
    days: check(
      'days',
      number(input.days),
      (v) => v >= 0 && v <= 3650,
      'Days to expiry must be 0 to 3650.',
    ),
    iv: check(
      'iv',
      number(input.iv),
      (v) => v > 0 && v <= 500,
      'Implied volatility must be above 0% and at most 500%.',
    ),
    rate: check(
      'rate',
      number(input.rate),
      (v) => v >= 0 && v <= 50,
      'Risk-free rate must be 0% to 50%.',
    ),
  };
  const rawLegs = input.legs ?? [];
  if (rawLegs.length === 0) errors.legs = 'Add at least one leg.';
  if (rawLegs.length > MAX_LEGS) errors.legs = `Use at most ${MAX_LEGS} legs.`;
  const legs = rawLegs.slice(0, MAX_LEGS).map((raw, index) => {
    const key = (field) => `legs.${index}.${field}`;
    const side = raw.side === 'sell' ? 'sell' : 'buy';
    const kind = ['call', 'put', 'future'].includes(raw.kind) ? raw.kind : 'call';
    return {
      side,
      kind,
      strike:
        kind === 'future'
          ? 0
          : check(key('strike'), number(raw.strike), (v) => v > 0, 'Strike must be above 0.'),
      premium: check(
        key('premium'),
        number(raw.premium),
        (v) => (kind === 'future' ? v > 0 : v >= 0),
        kind === 'future' ? 'Enter the futures entry price.' : 'Premium cannot be negative.',
      ),
      lots: check(
        key('lots'),
        number(raw.lots),
        (v) => Number.isInteger(v) && v >= 1 && v <= 1000,
        'Lots must be a whole number from 1 to 1000.',
      ),
      lotSize: check(
        key('lotSize'),
        number(raw.lotSize),
        (v) => Number.isInteger(v) && v >= 1 && v <= 100000,
        'Lot size must be a whole number of at least 1.',
      ),
    };
  });
  return Object.keys(errors).length ? { errors } : { errors, market, legs };
}
