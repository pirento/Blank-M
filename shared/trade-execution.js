/**
 * How a trade was executed, beyond entry/exit/quantity: the stop-loss price,
 * entry and exit times (IST, same day), partial exits and the number of
 * orders on each side (the brokerage cap applies per order).
 *
 * Partial exits are stored as legs; the trade's exit price is their
 * quantity-weighted average and each leg counts as one exit order.
 */

export const MAX_EXIT_LEGS = 20;
const PRICE = /^\+?(?:\d+(?:\.\d{1,4})?|\.\d{1,4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const empty = (value) => value === null || value === undefined || value === '';
const round4 = (value) => Math.round(value * 10000) / 10000;

function price(value) {
  const text = String(value).trim();
  if (!PRICE.test(text)) return null;
  const number = Number(text);
  return number > 0 && number < 1e14 ? number : null;
}

function optionalCount(value) {
  if (empty(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : undefined;
}

/**
 * @param {object} input stopLoss, entryTime, exitTime, exitLegs, entryOrders, exitOrders
 * @param {{ type: 'Long'|'Short', entryPrice: number, quantity: number }} trade
 * @returns {{ values: object, exitPrice: number|null, errors: Record<string,string> }}
 *   exitPrice is the weighted average when partial exits were given.
 */
export function parseTradeExecution(input = {}, trade) {
  const errors = {};
  const values = {
    stopLoss: null,
    entryTime: null,
    exitTime: null,
    exitLegs: [],
    entryOrders: null,
    exitOrders: null,
  };

  if (!empty(input.stopLoss)) {
    const stop = price(input.stopLoss);
    if (stop === null) errors.stopLoss = 'Enter the stop-loss as a price.';
    else if (trade.type === 'Long' ? stop >= trade.entryPrice : stop <= trade.entryPrice) {
      errors.stopLoss =
        trade.type === 'Long'
          ? 'A long trade’s stop-loss must be below the entry price.'
          : 'A short trade’s stop-loss must be above the entry price.';
    } else values.stopLoss = stop;
  }

  for (const key of ['entryTime', 'exitTime']) {
    if (empty(input[key])) continue;
    if (!TIME.test(String(input[key]))) errors[key] = 'Use a 24-hour time such as 09:20.';
    else values[key] = String(input[key]);
  }
  if (values.entryTime && values.exitTime && values.exitTime < values.entryTime) {
    errors.exitTime = 'The exit time cannot be before the entry time.';
  }

  let exitPrice = null;
  const legs = Array.isArray(input.exitLegs)
    ? input.exitLegs.filter((leg) => !empty(leg?.price) || !empty(leg?.quantity))
    : [];
  if (legs.length > MAX_EXIT_LEGS) {
    errors.exitLegs = `Use at most ${MAX_EXIT_LEGS} partial exits.`;
  } else if (legs.length === 1) {
    errors.exitLegs = 'Fill in at least two partial exits, or remove the split.';
  } else if (legs.length > 1) {
    const parsed = legs.map((leg) => ({
      price: price(leg.price),
      quantity: Number(leg.quantity),
    }));
    if (
      parsed.some(
        (leg) => leg.price === null || !Number.isInteger(leg.quantity) || leg.quantity < 1,
      )
    ) {
      errors.exitLegs = 'Each partial exit needs a price and a whole quantity.';
    } else if (parsed.reduce((sum, leg) => sum + leg.quantity, 0) !== trade.quantity) {
      errors.exitLegs = `Partial exit quantities must add up to the trade quantity (${trade.quantity}).`;
    } else {
      values.exitLegs = parsed;
      const value = parsed.reduce((sum, leg) => sum + leg.price * leg.quantity, 0);
      exitPrice = round4(value / trade.quantity);
    }
  }

  for (const key of ['entryOrders', 'exitOrders']) {
    const count = optionalCount(input[key]);
    if (count === undefined) errors[key] = 'Orders must be a whole number from 1 to 1000.';
    else values[key] = count;
  }
  // Every partial exit is its own order.
  if (values.exitLegs.length) {
    values.exitOrders = Math.max(values.exitLegs.length, values.exitOrders ?? 0);
  }
  return { values, exitPrice, errors };
}

/** Planned risk in rupees implied by a stop-loss: distance × quantity. */
export function riskFromStop(entryPrice, stopLoss, quantity) {
  if (!(stopLoss > 0) || !(entryPrice > 0) || !(quantity > 0)) return null;
  return Math.round(Math.abs(entryPrice - stopLoss) * quantity * 100) / 100;
}
