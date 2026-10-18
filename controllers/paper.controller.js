/**
 * Paper trading endpoints: list, start, check prices, close and delete
 * simulated trades, plus the scheduled price check for paper trades and price
 * alerts (CRON_SECRET).
 */
import * as paper from '../services/journal/paper.js';
import { checkAllAlerts } from '../services/notifications/price-alerts.js';
import { authorizeMaintenance } from '../services/maintenance/authorize.js';
import { requireMethod } from '../services/http.js';
import { placePendingAutoGtts } from '../services/broker/live-orders.js';

/** GET /api/paper: open and recent closed paper trades, with a summary of the closed ones. */
export async function list(req, res) {
  res.json(await paper.listPaperTrades(req.member.userId));
}

/** POST /api/paper: starts a paper trade at the current price (201). */
export async function start(req, res) {
  res.status(201).json({ trade: await paper.startPaperTrade(req.member.userId, req.body) });
}

/** POST /api/paper/refresh: checks the member's open paper trades against current prices. */
export async function refresh(req, res) {
  res.json(await paper.refreshPaperTrades(req.member.userId));
}

/**
 * POST /api/paper/:id/close: closes an open paper trade at the live price (409 when already
 * closed).
 */
export async function close(req, res) {
  res.json({ trade: await paper.closePaperTrade(req.member.userId, req.params.id) });
}

/** DELETE /api/paper/:id: deletes one of the member's paper trades (404 when not found). */
export async function remove(req, res) {
  await paper.deletePaperTrade(req.member.userId, req.params.id);
  res.json({ ok: true });
}

/**
 * POST /api/maintenance/price-checks: closes paper trades whose stop or target
 * was crossed, fires price alerts and places automatic stop/target GTTs for
 * filled live orders.
 */
export async function runPriceChecks(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!requireMethod(req, res, 'POST')) return;
  if (!authorizeMaintenance(req, res)) return;
  res.json({
    paper: await paper.checkAllPaperTrades(),
    alerts: await checkAllAlerts(),
    autoGtt: await placePendingAutoGtts(),
  });
}
