/**
 * Price alerts: create, list, delete and re-arm alerts, and check active ones
 * against the live price. An alert fires once (it is marked triggered
 * atomically, so two checks can never notify twice) and notifies the member by
 * push and/or email. Checks run while the Watchlist is open and from the
 * scheduled price check.
 */
import { z } from 'zod';
import { PriceAlert, TRADE_SYMBOL_RE } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { getQuote } from '../market/index.js';
import { createLogger } from '../logger.js';
import { notifyMember } from './notify.js';

const log = createLogger('alerts');
export const MAX_ACTIVE_ALERTS = 50;

/** API shape of a price alert; push is on unless explicitly disabled, email only when enabled. */
export function toAlert(row) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    id: row._id,
    symbol: row.symbol,
    condition: row.condition,
    price: row.price,
    note: row.note,
    status: row.status,
    channels: { email: Boolean(row.channels?.email), push: row.channels?.push !== false },
    triggeredAt: iso(row.triggeredAt),
    triggeredPrice: row.triggeredPrice,
    createdAt: iso(row.createdAt),
  };
}

const alertSchema = z.object({
  symbol: z.string(),
  condition: z.enum(['above', 'below']),
  price: z.union([z.number(), z.string()]),
  note: z.string().max(200).default(''),
  channels: z
    .object({ email: z.boolean().default(false), push: z.boolean().default(true) })
    .default({}),
});

/**
 * Validates and saves a new active alert (price rounded to paise). Throws HttpError 400 for invalid
 * input, 409 once the member has MAX_ACTIVE_ALERTS active alerts.
 */
export async function createAlert(userId, input) {
  const parsed = alertSchema.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError('Enter a symbol, a condition and a price.', 400);
  const symbol = parsed.data.symbol.trim().toUpperCase();
  if (!TRADE_SYMBOL_RE.test(symbol)) throw new HttpError('Enter a valid symbol.', 400);
  const price = Number(parsed.data.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1e8) {
    throw new HttpError('The alert price must be a positive amount.', 400);
  }
  if ((await PriceAlert.countDocuments({ userId, status: 'active' })) >= MAX_ACTIVE_ALERTS) {
    throw new HttpError(`You can have at most ${MAX_ACTIVE_ALERTS} active alerts.`, 409);
  }
  const row = await PriceAlert.create({
    userId,
    symbol,
    condition: parsed.data.condition,
    price: Math.round(price * 100) / 100,
    note: parsed.data.note.trim(),
    channels: parsed.data.channels,
  });
  return toAlert(row.toObject());
}

/** Up to 200 of the member's alerts: active before triggered, newest first within each. */
export async function listAlerts(userId) {
  const rows = await PriceAlert.find({ userId })
    .sort({ status: 1, createdAt: -1 })
    .limit(200)
    .lean();
  return rows.map(toAlert);
}

/** Deletes one of the member's alerts. Throws HttpError 404 when it does not exist. */
export async function deleteAlert(userId, id) {
  const result = await PriceAlert.deleteOne({ _id: id, userId });
  if (!result.deletedCount) throw new HttpError('This alert is no longer available.', 404);
}

/** Re-arms a triggered alert at the same level. */
export async function reactivateAlert(userId, id) {
  const current = await PriceAlert.findOne({ _id: id, userId }).lean();
  if (!current) throw new HttpError('This alert is no longer available.', 404);
  // Re-arming an alert that is already active changes nothing and is not limited.
  if (current.status === 'active') return toAlert(current);
  if ((await PriceAlert.countDocuments({ userId, status: 'active' })) >= MAX_ACTIVE_ALERTS) {
    throw new HttpError(`You can have at most ${MAX_ACTIVE_ALERTS} active alerts.`, 409);
  }
  const row = await PriceAlert.findOneAndUpdate(
    { _id: id, userId },
    { $set: { status: 'active', triggeredAt: null, triggeredPrice: null } },
    { new: true },
  ).lean();
  if (!row) throw new HttpError('This alert is no longer available.', 404);
  return toAlert(row);
}

/** Whether `price` meets the alert's condition (at or above / at or below its level). */
export const alertReached = (alert, price) =>
  alert.condition === 'above' ? price >= alert.price : price <= alert.price;

/** Checks the given active alerts (one price per member and symbol). Returns those that fired. */
async function checkAlerts(rows) {
  const fired = [];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.userId}:${row.symbol}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    let price;
    try {
      price = Number((await getQuote(group[0].symbol, group[0].userId)).price);
    } catch {
      continue;
    }
    if (!(price > 0)) continue;
    for (const row of group) {
      if (!alertReached(row, price)) continue;
      const claimed = await PriceAlert.findOneAndUpdate(
        { _id: row._id, status: 'active' },
        { $set: { status: 'triggered', triggeredAt: new Date(), triggeredPrice: price } },
        { new: true },
      ).lean();
      if (!claimed) continue;
      const direction = claimed.condition === 'above' ? 'rose to' : 'fell to';
      await notifyMember(
        claimed.userId,
        {
          title: `${claimed.symbol} ${direction} ₹${price}`,
          body: `Your alert at ₹${claimed.price} (${claimed.condition}) fired.${claimed.note ? ` ${claimed.note}` : ''}`,
          url: '/watchlist',
          tag: `alert-${claimed._id}`,
        },
        claimed.channels,
      );
      fired.push(toAlert(claimed));
    }
  }
  return fired;
}

/** Checks the member's active alerts now (used while the Watchlist is open). */
export async function checkMemberAlerts(userId) {
  const fired = await checkAlerts(await PriceAlert.find({ userId, status: 'active' }).lean());
  return { fired, alerts: await listAlerts(userId) };
}

/** Scheduled check of every active alert. */
export async function checkAllAlerts() {
  const active = await PriceAlert.find({ status: 'active' }).lean();
  const fired = await checkAlerts(active);
  if (fired.length) log.info('price alerts fired', { fired: fired.length });
  return { checked: active.length, fired: fired.length };
}
