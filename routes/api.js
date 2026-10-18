/**
 * JSON API routes under /api. Each route maps to one controller handler.
 */
import { Router } from 'express';
import { asyncHandler as wrap } from '../services/errors.js';
import { requireApiAuth } from '../middleware/auth.js';
import * as market from '../controllers/market.controller.js';
import * as kite from '../controllers/kite.controller.js';
import * as dhan from '../controllers/dhan.controller.js';
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

const router = Router();

/* --------------------------- integrations & market -------------------------- */
router.get('/health', wrap(market.health));
// These enforce GET themselves, including consistent 405 responses.
router.all('/quote', wrap(market.quote));
router.get('/quotes/stream', requireApiAuth, wrap(market.quoteStream));
router.all('/history', wrap(market.history));
router.post('/instruments/refresh', wrap(market.refreshInstrumentMaster));
router.all('/research/runs', wrap(handleResearchRuns));
router.all('/maintenance/voice-notes', wrap(handleVoiceNoteCleanup));
router.all('/maintenance/weekly-reports', wrap(account.runWeeklyReports));
router.all('/maintenance/price-checks', wrap(paper.runPriceChecks));
router.all('/maintenance/daily-import', wrap(account.runDailyImports));
router.all('/maintenance/premarket-plan', wrap(account.runPremarketPlans));

/* ------------------------------------- AI ------------------------------------ */
router.post('/ai/chat', wrap(ai.handleChat));
router.post('/ai/analyze', wrap(ai.handleAnalyze));
router.post('/ai/briefing', wrap(ai.handleBriefing));
router.post('/ai/picks', wrap(ai.handlePicks));
router.post('/ai/review', wrap(ai.handleReview));
router.post('/ai/transcribe', wrap(ai.handleTranscribe));
router.post('/ai/journal-search', wrap(ai.handleJournalSearch));
router.post('/ai/symbol', wrap(ai.handleSymbol));
router.post('/ai/rule', wrap(ai.handleRule));
router.post('/ai/insights', wrap(ai.handleInsights));
router.post('/ai/coach-review', wrap(ai.handleCoachReview));
router.get('/ai/coach-reviews', wrap(ai.handleCoachReviews));

/* --------------------------------- Zerodha Kite ------------------------------- */
router.all('/kite/authorize', wrap(kite.authorize));
router.all('/kite/callback', wrap(kite.callback));
router.all('/kite/complete', wrap(kite.complete));
router.all('/kite/status', wrap(kite.status));
router.all('/kite/balance', wrap(kite.balance));
router.all('/kite/portfolio', wrap(kite.portfolio));
router.all('/kite/fills', wrap(kite.fills));
router.all('/kite/fills/import', wrap(kite.importFillsToJournal));
router.all('/kite/disconnect', wrap(kite.disconnect));
router.get('/dhan', requireApiAuth, wrap(dhan.status));
router.post('/dhan/connect', requireApiAuth, wrap(dhan.connect));
router.post('/dhan/disconnect', requireApiAuth, wrap(dhan.disconnect));
router.get('/dhan/fills', requireApiAuth, wrap(dhan.fills));
router.post('/dhan/fills/import', requireApiAuth, wrap(dhan.importToJournal));

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
router.put('/admin/ai/config', wrap(adminAi.handleUpdateAiConfig));
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
router.post('/paper', requireApiAuth, wrap(paper.start));
router.post('/paper/refresh', requireApiAuth, wrap(paper.refresh));
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
router.post('/telegram/link', requireApiAuth, wrap(telegram.link));
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
router.post('/account/weekly-report/send', requireApiAuth, wrap(account.sendMyWeeklyReport));
router.put('/account/live-trading', requireApiAuth, wrap(account.saveLiveTrading));
router.get('/live-orders', requireApiAuth, wrap(account.getLiveOrders));
router.post('/live-orders', requireApiAuth, wrap(account.createLiveOrder));
router.get('/share-links', requireApiAuth, wrap(account.listShareLinks));
router.post('/share-links', requireApiAuth, wrap(account.createShareLink));
router.post('/share-links/:id/revoke', requireApiAuth, wrap(account.revokeShareLink));
router.post('/live-orders/:id/gtt', requireApiAuth, wrap(account.createLiveOrderGtt));
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
