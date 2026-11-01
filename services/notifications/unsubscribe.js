/**
 * One-click unsubscribe for bulk emails (newsletters/announcements and the weekly report), as Gmail
 * and Yahoo require of bulk senders: a signed link in the body and List-Unsubscribe headers. The
 * token is `<userId>.<list>.<HMAC-SHA256 of userId:list>`, so it needs no database row and a mail
 * provider can use it without a session.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AccountSettings, User } from '../../models/index.js';
import { siteOrigin } from './email-layout.js';

/** The AccountSettings switch each list turns off. */
const LISTS = { announcements: 'announcementEmails', weekly: 'weeklyReportEmail' };
const TOKEN = /^([0-9a-f-]{36})\.(announcements|weekly)\.([A-Za-z0-9_-]{43})$/;

const secret = () => process.env.SESSION_SECRET || 'blank-development-quota-key';
// Namespaced like the other HMACs (accounts.js opaque), so it can never match one of them.
const sign = (userId, list) =>
  createHmac('sha256', secret()).update(`blank-unsubscribe:${userId}:${list}`).digest('base64url');

export function unsubscribeToken(userId, list) {
  return `${userId}.${list}.${sign(userId, list)}`;
}

/**
 * The body line and headers for a bulk email to this member, or none when APP_URL is unset.
 * Returns `{ line, headers }`.
 */
export function unsubscribeParts(userId, list) {
  const origin = siteOrigin();
  if (!origin) return { line: null, headers: undefined };
  const url = `${origin}/email/unsubscribe?t=${unsubscribeToken(userId, list)}`;
  return {
    line: `Unsubscribe: ${url}`,
    headers: {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/** `{ userId, list }` for a genuine token, otherwise null (checked in constant time). */
export function readUnsubscribeToken(token) {
  const match = TOKEN.exec(String(token ?? ''));
  if (!match) return null;
  const [, userId, list, signature] = match;
  const expected = Buffer.from(sign(userId, list));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? { userId, list }
    : null;
}

/** Turns the list off for a genuine token; a deleted member is a quiet no-op. */
export async function unsubscribe({ userId, list }) {
  if (!(await User.exists({ _id: userId }))) return;
  await AccountSettings.updateOne(
    { _id: userId },
    { $set: { [LISTS[list]]: false } },
    { upsert: true },
  );
}
