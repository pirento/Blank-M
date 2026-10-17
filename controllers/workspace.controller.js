/**
 * Journal data endpoints: trades, strategies, rules, watchlist, chat history
 * account settings and the interface language, always scoped to the signed-in
 * member.
 */
import * as workspace from '../services/journal/workspace.js';
import { computeCurrentBalance } from '../shared/pnl.js';
import { LANGUAGES, LANGUAGE_COOKIE } from '../services/i18n.js';
import { HttpError } from '../services/errors.js';
import { env } from '../config/env.js';

/** JSON endpoints for the owner's journal data. Every query is scoped to the session user. */

export async function snapshot(req, res) {
  const data = await workspace.loadWorkspace(req.member.userId);
  res.json({
    ...data,
    portfolioBalance: computeCurrentBalance(data.settings.openingBalance, data.trades),
  });
}

/** POST /api/trades: saves a new trade with P&L at the member's current charge rates (201). */
export async function createTrade(req, res) {
  res.status(201).json({ trade: await workspace.createTrade(req.member.userId, req.body) });
}

/**
 * PUT /api/trades/:id { ...fields, expectedOriginal? }: edits a trade. `expectedOriginal` is the
 * client's copy of the trade; 409 when the stored one has changed since.
 */
export async function updateTrade(req, res) {
  const { expectedOriginal, ...input } = req.body ?? {};
  res.json({
    trade: await workspace.updateTrade(req.member.userId, req.params.id, input, expectedOriginal),
  });
}

/** DELETE /api/trades/:id: deletes the trade and its stored screenshot (404 when not found). */
export async function deleteTrade(req, res) {
  await workspace.deleteTrade(req.member.userId, req.params.id);
  res.json({ ok: true });
}

/**
 * POST /api/trades/import { trade }: inserts one imported trade; existing IDs are never
 * overwritten.
 */
export async function importTrade(req, res) {
  res.json({ result: await workspace.importTrade(req.member.userId, req.body?.trade) });
}

/** POST /api/strategies: saves a new strategy (201). */
export async function createStrategy(req, res) {
  res.status(201).json({ strategy: await workspace.createStrategy(req.member.userId, req.body) });
}

/** PUT /api/strategies/:id: replaces a strategy's editable fields (404 when not the member's). */
export async function updateStrategy(req, res) {
  res.json({
    strategy: await workspace.updateStrategy(req.member.userId, req.params.id, req.body),
  });
}

/** PUT /api/strategies/:id/stage { stage, note }: moves the strategy and records the change. */
export async function setStrategyStage(req, res) {
  res.json({
    strategy: await workspace.setStrategyStage(req.member.userId, req.params.id, req.body),
  });
}

/** DELETE /api/strategies/:id: deletes the strategy and unlinks it from its trades, which are kept. */
export async function deleteStrategy(req, res) {
  await workspace.deleteStrategy(req.member.userId, req.params.id);
  res.json({ ok: true });
}

/** POST /api/rules: adds a rule at the end of the member's rule list (201). */
export async function createRule(req, res) {
  res.status(201).json({ rule: await workspace.createRule(req.member.userId, req.body) });
}

/** PUT /api/rules/:id: replaces a rule's section, definition and text (404 when not the member's). */
export async function updateRule(req, res) {
  res.json({ rule: await workspace.updateRule(req.member.userId, req.params.id, req.body) });
}

/** DELETE /api/rules/:id: deletes one of the member's rules (404 when not found). */
export async function deleteRule(req, res) {
  await workspace.deleteRule(req.member.userId, req.params.id);
  res.json({ ok: true });
}

/**
 * POST /api/watchlist { symbol }: adds an NSE symbol (201); an already listed symbol returns the
 * existing item.
 */
export async function addWatchlist(req, res) {
  res
    .status(201)
    .json({ item: await workspace.addToWatchlist(req.member.userId, req.body?.symbol) });
}

/** DELETE /api/watchlist/:id: removes one item from the watchlist (404 when not found). */
export async function removeWatchlist(req, res) {
  await workspace.removeFromWatchlist(req.member.userId, req.params.id);
  res.json({ ok: true });
}

/** GET /api/chat/messages: the member's most recent chat messages, oldest first. */
export async function listChat(req, res) {
  res.json({ messages: await workspace.loadChat(req.member.userId) });
}

/** POST /api/chat/messages: saves one chat message (201). */
export async function addChatMessage(req, res) {
  res.status(201).json({ message: await workspace.addChatMessage(req.member.userId, req.body) });
}

/** DELETE /api/chat/messages: deletes the member's whole chat history. */
export async function clearChat(req, res) {
  await workspace.deleteChatHistory(req.member.userId);
  res.json({ ok: true });
}

/**
 * PUT /api/settings: validates and saves a partial account settings update; returns the full
 * settings.
 */
export async function saveSettings(req, res) {
  const settings = await workspace.saveAccountSettings(req.member.userId, req.body ?? {});
  res.json({ settings });
}

/** PUT /api/settings/language { language }: remembers the interface language in a cookie. */
export async function saveLanguage(req, res) {
  const language = req.body?.language;
  if (!LANGUAGES.some((item) => item.value === language)) {
    throw new HttpError('Choose English or Hindi.', 400);
  }
  res.cookie(LANGUAGE_COOKIE, language, {
    maxAge: 365 * 86_400_000,
    sameSite: 'lax',
    secure: env.isProduction,
    httpOnly: false,
    path: '/',
  });
  res.json({ language });
}
