/**
 * JSON API routes under /api. Each route maps to one controller handler.
 */
import { Router } from 'express';
import { asyncHandler as wrap } from '../services/errors.js';
import { requireAdminMfa, requireApiAdmin, requireApiAuth } from '../middleware/auth.js';
import { requirePremium } from '../services/billing/membership.js';
import * as market from '../controllers/market.controller.js';
import * as kite from '../controllers/kite.controller.js';
import * as dhan from '../controllers/dhan.controller.js';
import { brokerHandlers } from '../controllers/brokers.controller.js';
import * as ai from '../controllers/ai.controller.js';
import * as adminAi from '../controllers/admin-ai.controller.js';
import * as admin from '../controllers/admin.controller.js';
import * as manualInvitations from '../controllers/manual-invitations.controller.js';
import { handleVoiceNoteCleanup } from '../controllers/voice-note-cleanup.controller.js';
import { handleResearchRuns } from '../controllers/research.controller.js';
import * as workspace from '../controllers/workspace.controller.js';
import * as uploads from '../controllers/uploads.controller.js';
import * as orderPlans from '../controllers/order-plans.controller.js';
import * as evidence from '../controllers/strategy-evidence.controller.js';
import * as account from '../controllers/account.controller.js';
import * as username from '../controllers/username.controller.js';
import * as paper from '../controllers/paper.controller.js';
import * as alerts from '../controllers/alerts.controller.js';
import * as telegram from '../controllers/telegram.controller.js';
import * as billing from '../controllers/billing.controller.js';
import * as adminPanel from '../controllers/admin-panel.controller.js';

const router = Router();
const upstox = brokerHandlers('upstox');
const fyers = brokerHandlers('fyers');
const angel = brokerHandlers('angel');

/**
 * Premium gates by feature key (services/billing/plan.js). They only bite when the
 * administrator has switched billing on and marked the feature as Premium.
 */
const premium = Object.fromEntries(
  ['ai', 'brokers', 'liveOrders', 'livePrices', 'telegram', 'paper', 'reports'].map((key) => [
    key,
    requirePremium(key),
  ]),
);

/* --------------------------- integrations & market -------------------------- */
router.get('/health', wrap(market.health));
// These enforce GET themselves, including consistent 405 responses.
router.all('/quote', wrap(market.quote));
router.get('/quotes/stream', requireApiAuth, premium.livePrices, wrap(market.quoteStream));
router.all('/history', wrap(market.history));
router.post('/instruments/refresh', wrap(market.refreshInstrumentMaster));
router.all('/research/runs', premium.ai, wrap(handleResearchRuns));
router.all('/maintenance/voice-notes', wrap(handleVoiceNoteCleanup));
router.all('/maintenance/weekly-reports', wrap(account.runWeeklyReports));
router.all('/maintenance/price-checks', wrap(paper.runPriceChecks));
router.all('/maintenance/daily-import', wrap(account.runDailyImports));
router.all('/maintenance/premarket-plan', wrap(account.runPremarketPlans));

/* ------------------------------------- AI ------------------------------------ */
router.post('/ai/chat', premium.ai, wrap(ai.handleChat));
router.post('/ai/analyze', premium.ai, wrap(ai.handleAnalyze));
router.post('/ai/briefing', premium.ai, wrap(ai.handleBriefing));
router.post('/ai/picks', premium.ai, wrap(ai.handlePicks));
router.post('/ai/review', premium.ai, wrap(ai.handleReview));
router.post('/ai/transcribe', premium.ai, wrap(ai.handleTranscribe));
router.post('/ai/journal-search', premium.ai, wrap(ai.handleJournalSearch));
router.post('/ai/symbol', premium.ai, wrap(ai.handleSymbol));
router.post('/ai/rule', premium.ai, wrap(ai.handleRule));
router.post('/ai/insights', premium.ai, wrap(ai.handleInsights));
router.post('/ai/coach-review', premium.ai, wrap(ai.handleCoachReview));
router.get('/ai/coach-reviews', premium.ai, wrap(ai.handleCoachReviews));

/* --------------------------------- Zerodha Kite ------------------------------- */
router.all('/kite/authorize', premium.brokers, wrap(kite.authorize));
router.all('/kite/callback', wrap(kite.callback));
router.all('/kite/complete', wrap(kite.complete));
router.all('/kite/status', wrap(kite.status));
router.all('/kite/balance', premium.brokers, wrap(kite.balance));
router.all('/kite/portfolio', premium.brokers, wrap(kite.portfolio));
router.all('/kite/fills', premium.brokers, wrap(kite.fills));
router.all('/kite/fills/import', premium.brokers, wrap(kite.importFillsToJournal));
router.all('/kite/disconnect', wrap(kite.disconnect));
router.get('/dhan', requireApiAuth, wrap(dhan.status));
router.post('/dhan/connect', requireApiAuth, premium.brokers, wrap(dhan.connect));
router.post('/dhan/disconnect', requireApiAuth, wrap(dhan.disconnect));
router.get('/dhan/fills', requireApiAuth, premium.brokers, wrap(dhan.fills));
router.post('/dhan/fills/import', requireApiAuth, premium.brokers, wrap(dhan.importToJournal));
// Upstox and Fyers log in over OAuth. Their callbacks are GET (CSRF-safe) and check the
// member and login state themselves, so a failure can redirect back to Settings.
router.get('/upstox', requireApiAuth, wrap(upstox.status));
router.post('/upstox/authorize', requireApiAuth, premium.brokers, wrap(upstox.authorize));
router.get('/upstox/callback', wrap(upstox.callback));
router.post('/upstox/disconnect', requireApiAuth, wrap(upstox.disconnect));
router.get('/upstox/fills', requireApiAuth, premium.brokers, wrap(upstox.fills));
router.post('/upstox/fills/import', requireApiAuth, premium.brokers, wrap(upstox.importToJournal));
router.get('/fyers', requireApiAuth, wrap(fyers.status));
router.post('/fyers/authorize', requireApiAuth, premium.brokers, wrap(fyers.authorize));
router.get('/fyers/callback', wrap(fyers.callback));
router.post('/fyers/disconnect', requireApiAuth, wrap(fyers.disconnect));
router.get('/fyers/fills', requireApiAuth, premium.brokers, wrap(fyers.fills));
router.post('/fyers/fills/import', requireApiAuth, premium.brokers, wrap(fyers.importToJournal));
router.get('/angel', requireApiAuth, wrap(angel.status));
router.post('/angel/connect', requireApiAuth, premium.brokers, wrap(angel.connect));
router.post('/angel/disconnect', requireApiAuth, wrap(angel.disconnect));
router.get('/angel/fills', requireApiAuth, premium.brokers, wrap(angel.fills));
router.post('/angel/fills/import', requireApiAuth, premium.brokers, wrap(angel.importToJournal));

/* ---------------------------------- billing ---------------------------------- */
router.post('/billing/razorpay/webhook', wrap(billing.webhook));
router.get('/billing', requireApiAuth, wrap(billing.status));
router.post('/billing/checkout', requireApiAuth, wrap(billing.checkout));
router.post('/billing/refresh', requireApiAuth, wrap(billing.refresh));
router.post('/billing/cancel', requireApiAuth, wrap(billing.cancel));

/* --------------------------------- admin panel -------------------------------- */
router.get('/admin/overview', requireApiAdmin, wrap(adminPanel.overview));
router.get('/admin/settings', requireApiAdmin, wrap(adminPanel.getSettings));
router.put('/admin/settings', requireApiAdmin, requireAdminMfa, wrap(adminPanel.saveSettings));
router.get('/admin/billing', requireApiAdmin, wrap(adminPanel.getBilling));
router.put('/admin/billing', requireApiAdmin, requireAdminMfa, wrap(adminPanel.saveBilling));
router.post('/admin/billing/check-keys', requireApiAdmin, wrap(adminPanel.checkRazorpayKeys));
router.get('/admin/payments', requireApiAdmin, wrap(adminPanel.listPayments));
router.get('/admin/memberships', requireApiAdmin, wrap(adminPanel.listMemberships));
router.post(
  '/admin/members/:userId/premium',
  requireApiAdmin,
  requireAdminMfa,
  wrap(adminPanel.grantMemberPremium),
);
router.get('/admin/audit', requireApiAdmin, wrap(adminPanel.listAudit));

/* ------------------------------- administration ------------------------------ */
router.get('/admin/users', wrap(admin.handleListUsers));
router.post('/admin/users/invite', wrap(admin.handleInviteUser));
router.post('/admin/users/resend', wrap(admin.handleResendInvite));
router.post('/admin/users/revoke', wrap(admin.handleRevokeUser));
router.post('/admin/users/reset-link', wrap(admin.handleCreateResetLink));
router.all('/admin/manual-invitations', wrap(manualInvitations.handleManualInvitations));
router.all(
  '/admin/manual-invitations/revoke',
  wrap(manualInvitations.handleRevokeManualInvitation),
);
router.get('/admin/ai/config', wrap(adminAi.handleGetAiConfig));
router.put(
  '/admin/ai/config',
  requireApiAdmin,
  requireAdminMfa,
  wrap(adminAi.handleUpdateAiConfig),
);
router.post('/admin/ai/test', wrap(adminAi.handleTestAiConfig));
router.all('/invitations/accept', wrap(manualInvitations.handleAcceptManualInvitation));

/* ------------------------------- member workspace ----------------------------- */
router.get('/workspace', requireApiAuth, wrap(workspace.snapshot));
router.post('/trades', requireApiAuth, wrap(workspace.createTrade));
router.post('/trades/import', requireApiAuth, wrap(workspace.importTrade));
router.put('/trades/:id', requireApiAuth, wrap(workspace.updateTrade));
router.delete('/trades/:id', requireApiAuth, wrap(workspace.deleteTrade));
router.post(
  '/trades/:id/screenshot',
  requireApiAuth,
  uploads.singleFile,
  wrap(uploads.uploadTradeScreenshot),
);
router.get('/trades/:id/screenshot', requireApiAuth, wrap(uploads.getTradeScreenshot));
router.delete('/trades/:id/screenshot', requireApiAuth, wrap(uploads.deleteTradeScreenshot));

/* --------------------------------- paper trading --------------------------------- */
router.get('/paper', requireApiAuth, wrap(paper.list));
router.post('/paper', requireApiAuth, premium.paper, wrap(paper.start));
router.post('/paper/refresh', requireApiAuth, premium.paper, wrap(paper.refresh));
router.post('/paper/:id/close', requireApiAuth, wrap(paper.close));
router.delete('/paper/:id', requireApiAuth, wrap(paper.remove));

/* --------------------------- price alerts & notifications --------------------------- */
router.get('/alerts', requireApiAuth, wrap(alerts.list));
router.post('/alerts', requireApiAuth, wrap(alerts.create));
router.post('/alerts/check', requireApiAuth, wrap(alerts.check));
router.post('/alerts/:id/reactivate', requireApiAuth, wrap(alerts.reactivate));
router.delete('/alerts/:id', requireApiAuth, wrap(alerts.remove));
router.get('/push', requireApiAuth, wrap(alerts.pushConfig));
router.post('/push/subscribe', requireApiAuth, wrap(alerts.pushSubscribe));
router.post('/push/unsubscribe', requireApiAuth, wrap(alerts.pushUnsubscribe));
router.post('/push/test', requireApiAuth, wrap(alerts.pushTest));
router.post('/telegram/webhook', wrap(telegram.webhook));
router.get('/telegram', requireApiAuth, wrap(telegram.status));
router.post('/telegram/link', requireApiAuth, premium.telegram, wrap(telegram.link));
router.post('/telegram/unlink', requireApiAuth, wrap(telegram.unlink));
router.post('/strategies', requireApiAuth, wrap(workspace.createStrategy));
router.put('/strategies/:id', requireApiAuth, wrap(workspace.updateStrategy));
router.put('/strategies/:id/stage', requireApiAuth, wrap(workspace.setStrategyStage));
router.delete('/strategies/:id', requireApiAuth, wrap(workspace.deleteStrategy));
router.post('/rules', requireApiAuth, wrap(workspace.createRule));
router.put('/rules/:id', requireApiAuth, wrap(workspace.updateRule));
router.delete('/rules/:id', requireApiAuth, wrap(workspace.deleteRule));
router.post('/watchlist', requireApiAuth, wrap(workspace.addWatchlist));
router.delete('/watchlist/:id', requireApiAuth, wrap(workspace.removeWatchlist));
router.get('/chat/messages', requireApiAuth, wrap(workspace.listChat));
router.post('/chat/messages', requireApiAuth, wrap(workspace.addChatMessage));
router.delete('/chat/messages', requireApiAuth, wrap(workspace.clearChat));
router.put('/settings', requireApiAuth, wrap(workspace.saveSettings));
router.put('/settings/language', requireApiAuth, wrap(workspace.saveLanguage));
router.get('/account/sessions', requireApiAuth, wrap(account.listSessions));
router.post('/account/sessions/revoke', requireApiAuth, wrap(account.revokeSession));
router.post('/account/sessions/revoke-others', requireApiAuth, wrap(account.revokeOtherSessions));
router.get('/account/export', requireApiAuth, wrap(account.exportBackup));
router.post('/account/restore', requireApiAuth, account.backupFile, wrap(account.importBackup));
router.get('/account/notifications', requireApiAuth, wrap(account.getNotifications));
router.put('/account/notifications', requireApiAuth, wrap(account.saveNotifications));
router.post(
  '/account/weekly-report/send',
  requireApiAuth,
  premium.reports,
  wrap(account.sendMyWeeklyReport),
);
router.put('/account/live-trading', requireApiAuth, wrap(account.saveLiveTrading));
router.get('/live-orders', requireApiAuth, wrap(account.getLiveOrders));
router.post('/live-orders', requireApiAuth, premium.liveOrders, wrap(account.createLiveOrder));
router.get('/share-links', requireApiAuth, wrap(account.listShareLinks));
router.post('/share-links', requireApiAuth, wrap(account.createShareLink));
router.post('/share-links/:id/revoke', requireApiAuth, wrap(account.revokeShareLink));
router.post(
  '/live-orders/:id/gtt',
  requireApiAuth,
  premium.liveOrders,
  wrap(account.createLiveOrderGtt),
);
router.get('/username', requireApiAuth, wrap(username.getUsername));
router.post('/username', requireApiAuth, wrap(username.claimUsername));

router.post(
  '/uploads/statements',
  requireApiAuth,
  uploads.singleFile,
  wrap(uploads.uploadStatement),
);
router.post(
  '/uploads/voice-notes',
  requireApiAuth,
  uploads.singleFile,
  wrap(uploads.uploadVoiceNote),
);
router.delete('/uploads/voice-notes', requireApiAuth, wrap(uploads.removeVoiceNote));
router.post('/import/workbook', requireApiAuth, uploads.singleFile, wrap(uploads.parseWorkbook));

router.get('/order-plans', requireApiAuth, wrap(orderPlans.listRecords));
router.post('/order-plans', requireApiAuth, wrap(orderPlans.appendRecord));

router.get('/strategy-evidence', requireApiAuth, wrap(evidence.listEvidence));
router.post('/strategy-evidence', requireApiAuth, wrap(evidence.saveEvidence));
router.get('/strategy-evidence/:id/reviews', requireApiAuth, wrap(evidence.listReviews));
router.post('/strategy-evidence/:id/reviews', requireApiAuth, wrap(evidence.appendReview));

export default router;
