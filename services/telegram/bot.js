/**
 * The Telegram bot: link codes, the chat ↔ member link, and the commands a
 * linked chat can use. Every command runs as the linked member only; unknown
 * chats are told how to link and nothing else.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PriceAlert, TelegramLink, TelegramLinkCode, Trade, User } from '../../models/index.js';
import { todayInIst } from '../../shared/market.js';
import { summarisePerformance } from '../../shared/pnl.js';
import { HttpError } from '../errors.js';
import { createLogger } from '../logger.js';
import { reserveAttempts } from '../rate-window.js';
import { accessProblem } from '../auth/accounts.js';
import { createTrade, toTrade } from '../journal/workspace.js';
import { botUsername, isTelegramConfigured, sendTelegramMessage } from './api.js';

const log = createLogger('telegram');
const CODE_TTL_MS = 10 * 60_000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const money = (value) => `${value < 0 ? '-' : '+'}₹${Math.abs(value).toLocaleString('en-IN')}`;

export const HELP = [
  'Blank commands:',
  '/log SYMBOL LONG|SHORT QTY ENTRY EXIT [notes] — log a trade dated today',
  '   e.g. /log INFY LONG 10 1500 1520 breakout held',
  '/today — today’s trades and net P&L',
  '/week — the last 7 days',
  '/alerts — your active price alerts',
  '/unlink — disconnect this chat',
].join('\n');

/* --------------------------------- linking (settings) --------------------------------- */

/** Telegram card state for Settings: is the bot configured, its username, and whether this member's chat is linked. */
export async function telegramStatus(userId) {
  const link = await TelegramLink.findOne({ userId }).lean();
  return {
    configured: isTelegramConfigured(),
    bot: isTelegramConfigured() ? botUsername() : null,
    linked: Boolean(link),
    username: link?.username || null,
  };
}

/** A one-time link (t.me deep link) valid for 10 minutes. */
export async function createLinkCode(userId) {
  if (!isTelegramConfigured())
    throw new HttpError('Telegram is not configured on this server.', 503);
  const code = randomBytes(18).toString('base64url');
  await TelegramLinkCode.deleteMany({ userId });
  await TelegramLinkCode.create({
    _id: digest(code),
    userId,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return { url: `https://t.me/${botUsername()}?start=${code}`, expiresInMinutes: 10 };
}

/** Removes the member's Telegram chat link, if any. */
export async function unlinkTelegram(userId) {
  await TelegramLink.deleteOne({ userId });
}

/** Sends a notification to the member's linked chat, if any. Returns true when sent. */
export async function sendToMember(userId, text) {
  if (!isTelegramConfigured()) return false;
  const link = await TelegramLink.findOne({ userId }).lean();
  if (!link) return false;
  try {
    await sendTelegramMessage(link.chatId, text);
    return true;
  } catch {
    log.warn('telegram delivery failed');
    return false;
  }
}

/* ----------------------------------- commands ----------------------------------- */

/** Parses `/log SYMBOL LONG|SHORT QTY ENTRY EXIT [notes]` into a trade input, or an error text. */
export function parseLogCommand(args) {
  const [symbol, side, quantity, entry, exit, ...notes] = args;
  if (!symbol || !side || !quantity || !entry || !exit) {
    return { error: 'Usage: /log SYMBOL LONG|SHORT QTY ENTRY EXIT [notes]' };
  }
  const direction = { LONG: 'Long', BUY: 'Long', SHORT: 'Short', SELL: 'Short' }[
    side.toUpperCase()
  ];
  if (!direction) return { error: 'Direction must be LONG or SHORT.' };
  return {
    input: {
      date: todayInIst(),
      symbol,
      type: direction,
      quantity,
      entryPrice: entry,
      exitPrice: exit,
      notes: notes.join(' ').slice(0, 2000),
    },
  };
}

/** The member's trades from `from` to `to` (IST dates) as a short chat message. */
export async function summaryFor(userId, from, to, title) {
  const rows = await Trade.find({ userId, tradeDate: { $gte: from, $lte: to } }).lean();
  const trades = rows.map(toTrade);
  if (!trades.length) return `${title}: no trades.`;
  const summary = summarisePerformance(trades);
  const lines = trades
    .slice(0, 15)
    .map((trade) => `${trade.date} ${trade.symbol} ${trade.type} ${money(trade.pnl)}`);
  return [
    `${title}: ${summary.totalTrades} trades, net ${money(summary.netPnl)}, win rate ${summary.winRate.toFixed(0)}%`,
    ...lines,
    trades.length > 15 ? `…and ${trades.length - 15} more in Blank.` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function runCommand(link, command, args) {
  const userId = link.userId;
  switch (command) {
    case '/help':
    case '/start':
      return HELP;
    case '/log': {
      const parsed = parseLogCommand(args);
      if (parsed.error) return parsed.error;
      try {
        const trade = await createTrade(userId, parsed.input);
        return `Logged ${trade.symbol} ${trade.type} ${trade.quantity} @ ${trade.entryPrice} → ${trade.exitPrice}: net ${money(trade.pnl)} (charges ₹${trade.charges}).`;
      } catch (error) {
        return error instanceof HttpError
          ? `Not logged: ${error.message}`
          : 'Not logged: try again.';
      }
    }
    case '/today': {
      const today = todayInIst();
      return summaryFor(userId, today, today, `Today (${today})`);
    }
    case '/week': {
      const to = todayInIst();
      const from = new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return summaryFor(userId, from, to, `Last 7 days (${from} to ${to})`);
    }
    case '/alerts': {
      const alerts = await PriceAlert.find({ userId, status: 'active' }).limit(20).lean();
      return alerts.length
        ? [
            'Active alerts:',
            ...alerts.map((a) => `${a.symbol} ${a.condition === 'above' ? '≥' : '≤'} ₹${a.price}`),
          ].join('\n')
        : 'No active alerts. Add them on the Watchlist page.';
    }
    case '/unlink':
      await TelegramLink.deleteOne({ _id: link._id });
      return 'This chat is no longer linked to Blank.';
    default:
      return `Unknown command.\n\n${HELP}`;
  }
}

/** Links a chat with a one-time code from /start <code>. Returns the reply text. */
async function linkChat(chat, from, code) {
  const row = await TelegramLinkCode.findOneAndDelete({
    _id: digest(code),
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!row)
    return 'This link has expired or was already used. Create a new one in Blank → Settings → Telegram.';
  const user = await User.findById(row.userId).lean();
  if (!user || (await accessProblem(user))) return 'This Blank account cannot be linked.';
  // One chat per member and one member per chat.
  await TelegramLink.deleteMany({ $or: [{ userId: row.userId }, { chatId: String(chat.id) }] });
  await TelegramLink.create({
    userId: row.userId,
    chatId: String(chat.id),
    username: from?.username ? `@${from.username}` : '',
  });
  return `Linked to Blank. Price alerts will arrive here.\n\n${HELP}`;
}

/** Handles one webhook update; replies in the same chat. */
export async function handleUpdate(update) {
  const message = update?.message;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const chat = message?.chat;
  if (!text || !chat || chat.type !== 'private') return;
  // Telegram redelivers an update when our answer is slow or lost; handle each
  // once so a repeated /log never journals the same trade twice.
  if (Number.isSafeInteger(update.update_id)) {
    const first = await reserveAttempts(
      [{ key: `telegram-update:${update.update_id}`, limit: 1 }],
      24 * 60 * 60_000,
    );
    if (!first.allowed) return;
  }
  const quota = await reserveAttempts(
    [{ key: `telegram:${digest(String(chat.id)).slice(0, 32)}`, limit: 30 }],
    60_000,
  );
  if (!quota.allowed) return;
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, '');
  let reply;
  if (command === '/chatid') {
    // For ALERT_TELEGRAM_CHAT_ID; a chat may always learn its own ID.
    reply = `This chat's ID: ${chat.id}`;
  } else if (command === '/start' && args[0] && /^[A-Za-z0-9_-]{24}$/.test(args[0])) {
    reply = await linkChat(chat, message.from, args[0]);
  } else {
    const link = await TelegramLink.findOne({ chatId: String(chat.id) }).lean();
    const user = link ? await User.findById(link.userId).lean() : null;
    reply =
      !link || !user
        ? 'This chat is not linked. In Blank, open Settings → Telegram and choose “Link Telegram”.'
        : (await accessProblem(user))
          ? 'Your Blank access is not active.'
          : await runCommand(link, command, args);
  }
  try {
    await sendTelegramMessage(chat.id, reply);
  } catch {
    log.warn('telegram reply failed');
  }
}
