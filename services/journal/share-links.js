/**
 * Read-only mentor links: create (the URL is shown once), list, revoke, and
 * resolve a token to the shared journal. A shared view contains trades and
 * their review tags (notes only when chosen) — never capital, balances,
 * settings, plans, chat or the member's email.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ShareLink, Strategy, Trade, User } from '../../models/index.js';
import { accessProblem } from '../auth/accounts.js';
import { HttpError } from '../errors.js';
import { toTrade } from './workspace.js';

export const MAX_ACTIVE_LINKS = 10;
const EXPIRY_DAYS = [7, 30, 90];
const digest = (token) => createHash('sha256').update(token).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * API shape of a share link with its status (active, expired or revoked); never includes the token
 * or its hash.
 */
export function toShareLink(row) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);
  const now = Date.now();
  return {
    id: row._id,
    label: row.label,
    includeNotes: row.includeNotes,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    status: row.revokedAt ? 'revoked' : row.expiresAt.getTime() <= now ? 'expired' : 'active',
    lastViewedAt: iso(row.lastViewedAt),
    viewCount: row.viewCount,
  };
}

function appOrigin() {
  try {
    return new URL(process.env.APP_URL || '').origin;
  } catch {
    throw new HttpError('APP_URL must be configured before creating share links.', 503);
  }
}

const createSchema = z
  .object({
    label: z.string().trim().max(80).default(''),
    days: z
      .number()
      .int()
      .refine((value) => EXPIRY_DAYS.includes(value))
      .default(30),
    includeNotes: z.boolean().default(false),
  })
  .strict();

/** Creates a link; the returned `url` is the only time the token is visible. */
export async function createShareLink(userId, input) {
  const parsed = createSchema.safeParse(input ?? {});
  if (!parsed.success)
    throw new HttpError('Choose a label and an expiry of 7, 30 or 90 days.', 400);
  const active = await ShareLink.countDocuments({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (active >= MAX_ACTIVE_LINKS) {
    throw new HttpError(`You can have at most ${MAX_ACTIVE_LINKS} active share links.`, 409);
  }
  const origin = appOrigin();
  const token = randomBytes(32).toString('base64url');
  const row = await ShareLink.create({
    userId,
    tokenHash: digest(token),
    label: parsed.data.label,
    includeNotes: parsed.data.includeNotes,
    expiresAt: new Date(Date.now() + parsed.data.days * 86_400_000),
  });
  return { link: toShareLink(row.toObject()), url: `${origin}/share/${token}` };
}

/** The member's 50 most recent share links, newest first. */
export async function listShareLinks(userId) {
  const rows = await ShareLink.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map(toShareLink);
}

/**
 * Revokes one of the member's share links and returns it. Throws HttpError 404 when it is not
 * theirs or missing.
 */
export async function revokeShareLink(userId, id) {
  const row = await ShareLink.findOneAndUpdate(
    { _id: id, userId },
    { $set: { revokedAt: new Date() } },
    { new: true },
  ).lean();
  if (!row) throw new HttpError('This share link is no longer available.', 404);
  return toShareLink(row);
}

/**
 * The shared journal for a token, or null when the token is unknown, expired
 * or revoked (all look the same to the visitor).
 */
export async function openShareLink(token) {
  if (!TOKEN.test(String(token))) return null;
  const link = await ShareLink.findOneAndUpdate(
    { tokenHash: digest(token), revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { lastViewedAt: new Date() }, $inc: { viewCount: 1 } },
    { new: true },
  ).lean();
  if (!link) return null;
  // A suspended or removed member's journal stops being shared too.
  if (await accessProblem(await User.findById(link.userId).lean())) return null;
  const [trades, strategies] = await Promise.all([
    Trade.find({ userId: link.userId }).sort({ tradeDate: -1, _id: -1 }).limit(5000).lean(),
    Strategy.find({ userId: link.userId }, { name: 1 }).lean(),
  ]);
  return {
    label: link.label,
    expiresAt: link.expiresAt.toISOString(),
    includeNotes: link.includeNotes,
    strategies: strategies.map((strategy) => ({ id: strategy._id, name: strategy.name })),
    trades: trades.map((row) => {
      const trade = toTrade(row);
      // Screenshots stay private: the image endpoint needs the owner's session.
      const { hasScreenshot: _hasScreenshot, ...shared } = trade;
      return link.includeNotes ? shared : { ...shared, notes: '' };
    }),
  };
}
