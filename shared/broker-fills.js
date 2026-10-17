/**
 * Turns a day's broker fills into journal round trips. Fills of one
 * instrument and product are walked in time order; a round trip runs from flat
 * to flat (a fill that flips the position closes one trip and opens the next).
 * Entry and exit are the quantity-weighted average prices of the opening and
 * closing fills. Positions still open at the end are reported, not journaled.
 * Cash equity and NSE/BSE futures and options are supported.
 *
 * Positions carried in from earlier days (delivery holdings, overnight F&O)
 * are not part of today's round trips: a fill that reduces one while today's
 * own position is flat closes the carried position and is reported as
 * skipped, so selling a holding is never mistaken for an intraday short.
 */
import { segmentOfSymbol } from './segments.js';

/** Exchanges the journal can price: cash equity and equity derivatives. */
export const SUPPORTED_EXCHANGES = new Set(['NSE', 'BSE', 'NFO', 'BFO']);

const round4 = (value) => Math.round(value * 10000) / 10000;

function weightedAverage(lots) {
  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const value = lots.reduce((sum, lot) => sum + lot.quantity * lot.price, 0);
  return quantity ? round4(value / quantity) : 0;
}

/** Distinct orders behind some lots, or null when any lot has no order ID. */
function distinctOrders(lots) {
  if (lots.some((lot) => !lot.orderId)) return null;
  return new Set(lots.map((lot) => lot.orderId)).size;
}

const byTime = (left, right) =>
  (left.filledAt ?? '9999').localeCompare(right.filledAt ?? '9999') ||
  left.tradeId.localeCompare(right.tradeId);

/**
 * @param {object[]} fills broker trades: { symbol, exchange, product, side,
 *   quantity, averagePrice, tradeId, orderId, filledAt }
 * @param {{ carried?: Map<string, number> }} [options] signed quantity held
 *   before today, keyed `${exchange}:${symbol}:${product}`
 * @returns {{ trips: object[], open: object[], skipped: object[] }}
 *   trips: { key, symbol, exchange, product, type, quantity, entryPrice,
 *   exitPrice, fillIds, openedAt, closedAt }
 */
export function fillsToRoundTrips(fills, { carried = new Map() } = {}) {
  const groups = new Map();
  const skipped = [];
  for (const fill of fills) {
    if (!SUPPORTED_EXCHANGES.has(fill.exchange) || !segmentOfSymbol(fill.symbol, fill.exchange)) {
      skipped.push({
        symbol: fill.symbol,
        exchange: fill.exchange,
        reason: 'Only NSE/BSE equity, futures and options fills can be journaled.',
      });
      continue;
    }
    const key = `${fill.exchange}:${fill.symbol}:${fill.product}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fill);
  }

  const trips = [];
  const open = [];
  for (const [key, group] of groups) {
    const [exchange, symbol, product] = key.split(':');
    let position = 0;
    let cycle = null;
    let carriedLeft = carried.get(key) ?? 0;
    let carriedClosed = 0;
    for (const fill of [...group].sort(byTime)) {
      const sign = fill.side === 'BUY' ? 1 : -1;
      let remaining = fill.quantity;
      while (remaining > 0) {
        if (position === 0 && carriedLeft !== 0 && Math.sign(carriedLeft) !== sign) {
          // Today's own lots close first; only then does a fill reduce what was carried in.
          const closing = Math.min(remaining, Math.abs(carriedLeft));
          carriedLeft += sign * closing;
          carriedClosed += closing;
          remaining -= closing;
          continue;
        }
        if (position === 0) {
          cycle = {
            type: sign > 0 ? 'Long' : 'Short',
            opens: [],
            closes: [],
            fillIds: new Set(),
            openedAt: fill.filledAt,
          };
        }
        cycle.fillIds.add(fill.tradeId);
        if (position === 0 || Math.sign(position) === sign) {
          cycle.opens.push({
            quantity: remaining,
            price: fill.averagePrice,
            orderId: fill.orderId,
          });
          position += sign * remaining;
          remaining = 0;
        } else {
          const closing = Math.min(remaining, Math.abs(position));
          cycle.closes.push({ quantity: closing, price: fill.averagePrice, orderId: fill.orderId });
          position += sign * closing;
          remaining -= closing;
          if (position === 0) {
            const quantity = cycle.closes.reduce((sum, lot) => sum + lot.quantity, 0);
            trips.push({
              key,
              symbol,
              exchange,
              product,
              segment: segmentOfSymbol(symbol, exchange),
              type: cycle.type,
              quantity,
              entryPrice: weightedAverage(cycle.opens),
              exitPrice: weightedAverage(cycle.closes),
              fillIds: [...cycle.fillIds].sort(),
              entryOrders: distinctOrders(cycle.opens),
              exitOrders: distinctOrders(cycle.closes),
              openedAt: cycle.openedAt,
              closedAt: fill.filledAt,
            });
            cycle = null;
          }
        }
      }
    }
    if (position !== 0) {
      open.push({ symbol, exchange, product, quantity: position, fillIds: [...cycle.fillIds] });
    }
    if (carriedClosed > 0) {
      skipped.push({
        symbol,
        exchange,
        quantity: carriedClosed,
        reason: `Closed ${carriedClosed} carried in from an earlier day (not a same-day round trip).`,
      });
    }
  }
  trips.sort((left, right) => (left.closedAt ?? '').localeCompare(right.closedAt ?? ''));
  return { trips, open, skipped };
}
