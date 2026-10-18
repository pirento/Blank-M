/**
 * Today's broker fills (Zerodha, Dhan, Upstox, Fyers or Angel One) as journal trades: preview the round
 * trips and import the chosen ones. Fills are always re-read from the broker
 * on the server, so the browser only chooses which round trips to add. Each
 * round trip has an ID derived from its fills, so importing twice never
 * creates duplicates.
 */
import { createHash } from 'node:crypto';
import { Trade } from '../../models/index.js';
import { fillsToRoundTrips } from '../../shared/broker-fills.js';
import { computeTradeEconomics, validateTradeInput } from '../../shared/pnl.js';
import { chargesForSegment } from '../../shared/segments.js';
import { HttpError } from '../errors.js';
import { loadAccountSettings, toTrade } from '../journal/workspace.js';
import { readAngelFills } from './angel.js';
import { readDhanFills } from './dhan.js';
import { readFyersFills } from './fyers.js';
import { readUpstoxFills } from './upstox.js';
import { readBrokerPortfolio } from './portfolio.js';

/**
 * Quantities held before today, from a Kite snapshot: overnight F&O/margin
 * positions (net − day) and delivery holdings (including T1).
 */
export function carriedFromSnapshot(snapshot) {
  const carried = new Map();
  const day = new Map(
    (snapshot.positions?.day ?? []).map((row) => [
      `${row.exchange}:${row.symbol}:${row.product}`,
      row.quantity,
    ]),
  );
  for (const row of snapshot.positions?.net ?? []) {
    if (row.product === 'CNC') continue;
    const key = `${row.exchange}:${row.symbol}:${row.product}`;
    const overnight = row.quantity - (day.get(key) ?? 0);
    if (overnight !== 0) carried.set(key, overnight);
  }
  for (const holding of snapshot.holdings ?? []) {
    const quantity = holding.quantity + (holding.t1Quantity ?? 0);
    // A holding can be sold on either exchange.
    if (quantity > 0) {
      for (const exchange of ['NSE', 'BSE'])
        carried.set(`${exchange}:${holding.symbol}:CNC`, quantity);
    }
  }
  return carried;
}

/**
 * Where fills come from. `read` returns { tradingDate, fetchedAt, trades,
 * carried?, skipped? } (skipped: broker rows that could not be read).
 */
const SOURCES = {
  kite: {
    label: 'Zerodha',
    read: async (userId, assertAccess) => {
      const snapshot = await readBrokerPortfolio(userId, assertAccess);
      return { ...snapshot, carried: carriedFromSnapshot(snapshot) };
    },
  },
  dhan: { label: 'Dhan', read: (userId) => readDhanFills(userId) },
  upstox: { label: 'Upstox', read: (userId) => readUpstoxFills(userId) },
  fyers: { label: 'Fyers', read: (userId) => readFyersFills(userId) },
  angel: { label: 'Angel One', read: (userId) => readAngelFills(userId) },
};

function sourceOf(broker) {
  const source = SOURCES[broker];
  if (!source) throw new HttpError('Unknown broker.', 400);
  return source;
}

/** A UUID-shaped ID from the member and the round trip's fills (stable across reads). */
function tripId(broker, userId, trip) {
  const hex = createHash('sha256')
    .update(`blank-${broker}-fills-v1:${userId}:${trip.key}:${trip.type}:${trip.fillIds.join(',')}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function readTrips(broker, userId, assertAccess) {
  const snapshot = await sourceOf(broker).read(userId, assertAccess);
  const { trips, open, skipped } = fillsToRoundTrips(snapshot.trades, {
    carried: snapshot.carried,
  });
  const settings = await loadAccountSettings(userId);
  const ids = trips.map((trip) => tripId(broker, userId, trip));
  const existing = new Set(
    (await Trade.find({ userId, _id: { $in: ids } }, { _id: 1 }).lean()).map((row) => row._id),
  );
  const candidates = trips.map((trip, index) => {
    const values = {
      date: snapshot.tradingDate,
      symbol: trip.symbol,
      type: trip.type,
      entryPrice: trip.entryPrice,
      exitPrice: trip.exitPrice,
      quantity: trip.quantity,
    };
    const problem = Object.values(
      validateTradeInput({
        ...values,
        entryPrice: String(values.entryPrice),
        exitPrice: String(values.exitPrice),
        quantity: String(values.quantity),
      }),
    )[0];
    const orders = { entryOrders: trip.entryOrders ?? null, exitOrders: trip.exitOrders ?? null };
    const economics = computeTradeEconomics(
      { ...values, ...orders },
      chargesForSegment(settings, trip.segment),
    );
    return {
      id: ids[index],
      ...values,
      exchange: trip.exchange,
      product: trip.product,
      segment: trip.segment,
      fills: trip.fillIds.length,
      ...orders,
      grossPnl: economics.grossPnl,
      charges: economics.charges,
      pnl: economics.netPnl,
      alreadyInJournal: existing.has(ids[index]),
      problem: problem ?? null,
      fillIds: trip.fillIds,
    };
  });
  return {
    tradingDate: snapshot.tradingDate,
    fetchedAt: snapshot.fetchedAt,
    candidates,
    open,
    skipped: [...(snapshot.skipped ?? []), ...skipped],
  };
}

/** What would be added: round trips (marked when already journaled), open positions, skipped fills. */
export async function previewFills(userId, assertAccess, broker = 'kite') {
  const preview = await readTrips(broker, userId, assertAccess);
  return {
    ...preview,
    candidates: preview.candidates.map(({ fillIds: _fillIds, ...candidate }) => candidate),
  };
}

/** Adds the chosen round trips that are not yet in the journal. */
export async function importFills(userId, assertAccess, ids, broker = 'kite') {
  const { label } = sourceOf(broker);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
    throw new HttpError('Choose the round trips to add.', 400);
  }
  const wanted = new Set(ids.map(String));
  const { candidates } = await readTrips(broker, userId, assertAccess);
  const { added, skipped } = await saveCandidates(
    userId,
    label,
    candidates.filter((candidate) => wanted.has(candidate.id)),
  );
  const unknown = [...wanted].filter((id) => !candidates.some((candidate) => candidate.id === id));
  return { added, skipped: skipped + unknown.length };
}

/**
 * Adds every round trip of today that is not yet in the journal (the daily
 * automatic import). Also returns the positions still open.
 */
export async function importAllFills(userId, assertAccess, broker) {
  const { candidates, open } = await readTrips(broker, userId, assertAccess);
  return { ...(await saveCandidates(userId, sourceOf(broker).label, candidates)), open };
}

async function saveCandidates(userId, label, candidates) {
  const added = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.alreadyInJournal || candidate.problem) {
      skipped += 1;
      continue;
    }
    try {
      const row = await Trade.create({
        _id: candidate.id,
        userId,
        strategyId: null,
        tradeDate: candidate.date,
        symbol: candidate.symbol,
        direction: candidate.type,
        entryPrice: candidate.entryPrice,
        exitPrice: candidate.exitPrice,
        quantity: candidate.quantity,
        grossPnl: candidate.grossPnl,
        charges: candidate.charges,
        segment: candidate.segment,
        entryOrders: candidate.entryOrders,
        exitOrders: candidate.exitOrders,
        notes: `Added from ${label} fills (${candidate.exchange} ${candidate.product}, ${candidate.fills} ${candidate.fills === 1 ? 'fill' : 'fills'}: ${candidate.fillIds.join(', ')}).`,
      });
      added.push(toTrade(row.toObject()));
    } catch (error) {
      // Added by a parallel request: the stable ID makes the second insert a no-op.
      if (error?.code !== 11000) throw error;
      skipped += 1;
    }
  }
  return { added, skipped };
}
