/**
 * Paper trading: start a simulated trade at the live quote (manually or from a
 * synced order plan), check open trades against their stop and target, and
 * close them. No order is ever sent. A trade closes at the price observed by
 * the check that found its stop or target crossed (checks run while the Paper
 * trading page is open and from the scheduled price check).
 */
import { z } from 'zod';
import { OrderPlanRecord, PaperTrade, TRADE_SYMBOL_RE } from '../../models/index.js';
import { computeTradeEconomics, summarisePerformance } from '../../shared/pnl.js';
import { HttpError } from '../errors.js';
import { getQuote } from '../market/index.js';
import { createLogger } from '../logger.js';
import { loadAccountSettings } from './workspace.js';
import { inBatches } from '../batches.js';

const log = createLogger('paper');
export const MAX_OPEN_PAPER_TRADES = 50;
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * API shape of a paper trade, including the gross open P&L at the last observed price for open
 * trades.
 */
export function toPaperTrade(row) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  const sign = row.direction === 'Short' ? -1 : 1;
  return {
    id: row._id,
    planId: row.planId,
    symbol: row.symbol,
    direction: row.direction,
    quantity: row.quantity,
    entryPrice: row.entryPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    status: row.status,
    openedAt: iso(row.openedAt),
    lastPrice: row.lastPrice,
    lastPriceAt: iso(row.lastPriceAt),
    // Gross, before charges, at the last observed price.
    openPnl:
      row.status === 'open' && row.lastPrice !== null
        ? round2(sign * (row.lastPrice - row.entryPrice) * row.quantity)
        : null,
    closedAt: iso(row.closedAt),
    exitPrice: row.exitPrice,
    exitReason: row.exitReason,
    grossPnl: row.grossPnl,
    charges: row.charges,
    pnl: row.netPnl,
  };
}

async function livePrice(symbol, userId) {
  let price;
  try {
    price = Number((await getQuote(symbol, userId)).price);
  } catch {
    price = NaN;
  }
  if (!(price > 0)) throw new HttpError(`A current price for ${symbol} could not be read.`, 503);
  return round2(price);
}

const startSchema = z.object({
  planId: z.string().max(100).optional(),
  symbol: z.string().optional(),
  direction: z.enum(['Long', 'Short']).optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
  stopLoss: z.union([z.number(), z.string(), z.null()]).optional(),
  takeProfit: z.union([z.number(), z.string(), z.null()]).optional(),
});

const optionalPrice = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new HttpError('Prices must be positive.', 400);
  return round2(number);
};

/** The synced plan's symbol, direction, quantity, stop and target. */
async function planInputs(userId, planId) {
  const plan = await OrderPlanRecord.findOne({ userId, recordKey: `plan:${planId}` }).lean();
  if (!plan)
    throw new HttpError('This plan has not reached your account yet. Wait for it to sync.', 409);
  return {
    symbol: plan.record.symbol,
    direction: plan.record.direction,
    quantity: plan.record.estimate?.quantity,
    stopLoss: plan.record.inputs?.stopLoss,
    takeProfit: plan.record.inputs?.takeProfit ?? null,
  };
}

/** Starts a paper trade at the current price. */
export async function startPaperTrade(userId, input) {
  const parsed = startSchema.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError('Enter a complete paper trade.', 400);
  const fields = parsed.data.planId ? await planInputs(userId, parsed.data.planId) : parsed.data;
  const symbol = String(fields.symbol ?? '')
    .trim()
    .toUpperCase();
  if (!TRADE_SYMBOL_RE.test(symbol)) throw new HttpError('Enter a valid symbol.', 400);
  if (!['Long', 'Short'].includes(fields.direction))
    throw new HttpError('Choose Long or Short.', 400);
  const quantity = Number(fields.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new HttpError('Quantity must be a whole number of shares.', 400);
  }
  const stopLoss = optionalPrice(fields.stopLoss);
  const takeProfit = optionalPrice(fields.takeProfit);
  if ((await PaperTrade.countDocuments({ userId, status: 'open' })) >= MAX_OPEN_PAPER_TRADES) {
    throw new HttpError(`You can have at most ${MAX_OPEN_PAPER_TRADES} open paper trades.`, 409);
  }
  const entryPrice = await livePrice(symbol, userId);
  const long = fields.direction === 'Long';
  if (stopLoss !== null && (long ? stopLoss >= entryPrice : stopLoss <= entryPrice)) {
    throw new HttpError(
      `The stop (₹${stopLoss}) is already reached at the current price (₹${entryPrice}).`,
      409,
    );
  }
  if (takeProfit !== null && (long ? takeProfit <= entryPrice : takeProfit >= entryPrice)) {
    throw new HttpError(
      `The target (₹${takeProfit}) is already reached at the current price (₹${entryPrice}).`,
      409,
    );
  }
  const row = await PaperTrade.create({
    userId,
    planId: parsed.data.planId ?? null,
    symbol,
    direction: fields.direction,
    quantity,
    entryPrice,
    stopLoss,
    takeProfit,
    lastPrice: entryPrice,
    lastPriceAt: new Date(),
  });
  return toPaperTrade(row.toObject());
}

async function close(row, exitPrice, exitReason) {
  const settings = await loadAccountSettings(row.userId);
  const economics = computeTradeEconomics(
    { type: row.direction, entryPrice: row.entryPrice, exitPrice, quantity: row.quantity },
    settings.charges,
  );
  const closed = await PaperTrade.findOneAndUpdate(
    { _id: row._id, userId: row.userId, status: 'open' },
    {
      $set: {
        status: 'closed',
        closedAt: new Date(),
        exitPrice,
        exitReason,
        lastPrice: exitPrice,
        lastPriceAt: new Date(),
        grossPnl: economics.grossPnl,
        charges: economics.charges,
        netPnl: economics.netPnl,
      },
    },
    { new: true },
  ).lean();
  return closed;
}

/** Which exit (if any) a price triggers for an open paper trade. */
export function exitTriggered(row, price) {
  const long = row.direction === 'Long';
  if (row.stopLoss !== null && (long ? price <= row.stopLoss : price >= row.stopLoss))
    return 'stop';
  if (row.takeProfit !== null && (long ? price >= row.takeProfit : price <= row.takeProfit))
    return 'target';
  return null;
}

/**
 * Reads one price per symbol for the given open trades, records it, and closes
 * trades whose stop or target it crossed. Returns how many closed.
 */
/** `quoteUserId`: whose Zerodha session may price the trades (null: never another member's). */
async function checkTrades(rows, quoteUserId) {
  let closedCount = 0;
  const bySymbol = new Map();
  for (const row of rows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(row);
  }
  // A few symbols at a time; every open trade on a symbol (any member) shares one price.
  await inBatches([...bySymbol], 8, async ([symbol, group]) => {
    let price;
    try {
      price = await livePrice(symbol, quoteUserId);
    } catch {
      return; // Leave the trade open; the next check retries.
    }
    for (const row of group) {
      const reason = exitTriggered(row, price);
      if (reason) {
        if (await close(row, price, reason)) closedCount += 1;
      } else {
        await PaperTrade.updateOne(
          { _id: row._id, status: 'open' },
          { $set: { lastPrice: price, lastPriceAt: new Date() } },
        );
      }
    }
  });
  return closedCount;
}

/** Checks the member's open paper trades now. */
export async function refreshPaperTrades(userId) {
  const open = await PaperTrade.find({ userId, status: 'open' }).lean();
  const closedNow = await checkTrades(open, userId);
  return { ...(await listPaperTrades(userId)), closedNow };
}

/** Scheduled check of every member's open paper trades (one price per symbol for all of them). */
export async function checkAllPaperTrades() {
  const open = await PaperTrade.find({ status: 'open' }).lean();
  const closed = await checkTrades(open, null);
  if (closed) log.info('paper trades closed by price check', { closed });
  return { checked: open.length, closed };
}

/**
 * Closes an open paper trade manually at the current quote and returns it. Throws HttpError 404
 * when it is missing, 409 when already closed, 503 when no price can be read.
 */
export async function closePaperTrade(userId, id) {
  const row = await PaperTrade.findOne({ _id: id, userId }).lean();
  if (!row) throw new HttpError('This paper trade is no longer available.', 404);
  if (row.status !== 'open') throw new HttpError('This paper trade is already closed.', 409);
  const closed = await close(row, await livePrice(row.symbol, userId), 'manual');
  if (!closed) throw new HttpError('This paper trade is already closed.', 409);
  return toPaperTrade(closed);
}

/**
 * Deletes one of the member's paper trades, open or closed. Throws HttpError 404 when it does not
 * exist.
 */
export async function deletePaperTrade(userId, id) {
  const result = await PaperTrade.deleteOne({ _id: id, userId });
  if (!result.deletedCount) throw new HttpError('This paper trade is no longer available.', 404);
}

/** Open and recent closed paper trades, with a summary of the closed ones. */
export async function listPaperTrades(userId) {
  const [open, closed] = await Promise.all([
    PaperTrade.find({ userId, status: 'open' }).sort({ openedAt: -1 }).lean(),
    PaperTrade.find({ userId, status: 'closed' }).sort({ closedAt: -1 }).limit(500).lean(),
  ]);
  const closedTrades = closed.map(toPaperTrade);
  return {
    open: open.map(toPaperTrade),
    closed: closedTrades,
    summary: summarisePerformance(
      closedTrades.map((trade) => ({ ...trade, grossPnl: trade.grossPnl, charges: trade.charges })),
    ),
  };
}
