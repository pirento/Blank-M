/**
 * Broker instrument masters for the adapters (services/broker/adapters/): exchange + symbol →
 * the broker's own token, cached in BrokerInstrument and refreshed in bulk at most once a day
 * per broker. Also the NSE price-tick rule.
 */
import { BrokerInstrument } from '../../models/index.js';
import { MarketDataError } from '../market/types.js';
import { createLogger } from '../logger.js';
import { reserveAttempts } from '../rate-window.js';

const log = createLogger('broker-instruments');
const MAX_AGE_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 1000;
/** Across processes, one refresh per broker in this window; the others keep their cached rows. */
const REFRESH_LOCK_MS = 10 * 60_000;
const refreshing = new Map();

const text = (value) => (typeof value === 'string' || Number.isFinite(value) ? String(value) : '');
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/** Replaces `provider`'s rows with `loadAll()`'s. Returns false when another process holds the refresh. */
async function refresh(provider, loadAll) {
  const lock = await reserveAttempts(
    [{ key: `broker-instruments:${provider}`, limit: 1 }],
    REFRESH_LOCK_MS,
  );
  if (!lock.allowed) return false;
  const startedAt = new Date();
  let batch = [];
  let stored = 0;
  const flush = async () => {
    await BrokerInstrument.bulkWrite(
      batch.map((row) => ({
        updateOne: {
          filter: { _id: `${provider}:${row.exchange}:${row.symbol}` },
          update: { $set: { provider, ...row, updatedAt: startedAt } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    stored += batch.length;
    batch = [];
  };
  try {
    for await (const item of await loadAll()) {
      const row = {
        exchange: text(item?.exchange).trim().toUpperCase(),
        symbol: text(item?.symbol).trim().toUpperCase(),
        token: text(item?.token).trim(),
        isin: /^[A-Z0-9]{12}$/.test(item?.isin ?? '') ? item.isin : null,
        lotSize: positive(item?.lotSize),
        tickSize: positive(item?.tickSize),
      };
      // One unreadable row must not cost the member every other instrument.
      if (!row.exchange || !row.symbol || !row.token) continue;
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    if (batch.length) await flush();
    if (!stored) throw new MarketDataError(`The ${provider} instrument list was empty.`, 502);
  } catch (error) {
    // A partial list must not pass for a fresh one: the next lookup retries once the lock lapses.
    await BrokerInstrument.updateMany(
      { provider, updatedAt: { $gte: startedAt } },
      { $set: { updatedAt: new Date(0) } },
    );
    throw error;
  }
  // Only after a complete refresh: rows the broker no longer lists (expired or delisted).
  await BrokerInstrument.deleteMany({ provider, updatedAt: { $lt: startedAt } });
  return true;
}

/**
 * The cached `{ provider, exchange, symbol, token, isin, lotSize, tickSize, updatedAt }` row, or
 * null when the broker does not list it. When `provider`'s cache is missing or older than a day,
 * `loadAll()` (an array or async iterable of `{ exchange, symbol, token, isin?, lotSize?,
 * tickSize? }` from the broker's instrument master) refreshes all of its rows: one refresh per
 * broker at a time in this process, and across processes. Only a missing cache waits for it; a
 * day-old one answers at once and refreshes in the background. A failed refresh keeps the old
 * rows (and throws only when there are none).
 */
export async function brokerInstrument(provider, exchange, symbol, loadAll) {
  const oldest = await BrokerInstrument.findOne({ provider }, { updatedAt: 1 })
    .sort({ updatedAt: 1 })
    .lean();
  if (!oldest || Date.now() - oldest.updatedAt.getTime() > MAX_AGE_MS) {
    let run = refreshing.get(provider);
    if (!run) {
      run = refresh(provider, loadAll).finally(() => refreshing.delete(provider));
      refreshing.set(provider, run);
    }
    if (!oldest) {
      if (!(await run)) {
        throw new MarketDataError(
          'The broker instrument list is being loaded. Try again in a minute.',
          503,
        );
      }
    } else {
      // An order is waiting on this lookup: answer from the cached rows, refresh behind it.
      run.catch((error) =>
        log.warn('instrument refresh failed; using the cached list', {
          provider,
          reason: error?.message,
        }),
      );
    }
  }
  return BrokerInstrument.findById(
    `${provider}:${String(exchange).toUpperCase()}:${String(symbol).toUpperCase()}`,
  ).lean();
}

/**
 * NSE cash-market tick in paise for a price (price bands from April 2025): ₹0.05 up to ₹1,000
 * (also valid for the ₹0.01 band below ₹250), ₹0.10 to ₹5,000, ₹0.50 to ₹10,000, ₹1 to ₹20,000,
 * then ₹5. NSE reviews ticks monthly, so the broker stays the final check.
 */
function tickPaise(price) {
  if (price <= 1000) return 5;
  if (price <= 5000) return 10;
  if (price <= 10000) return 50;
  if (price <= 20000) return 100;
  return 500;
}

/**
 * Rounds a price to its NSE tick. Works in whole paise: dividing rupees by 0.05 is inexact
 * (100.05 / 0.05 = 2000.9999…) and would drop a tick.
 */
export function toTick(value, roundUp) {
  const paise = Math.round(value * 100);
  const tick = tickPaise(value);
  const ticks = roundUp ? Math.ceil(paise / tick) : Math.floor(paise / tick);
  return (ticks * tick) / 100;
}
