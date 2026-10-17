/**
 * Market endpoints: health/integration status, quotes, price history and the
 * instrument master refresh.
 */
import { requireMethod } from '../services/http.js';
import {
  MarketDataError,
  assertBoundedIntradayRange,
  assertValidDate,
  assertValidHistoryRange,
  assertValidInterval,
  assertValidSymbol,
  getHistory,
  getQuote,
  instrumentCount,
  isKiteConfigured,
  refreshInstruments,
} from '../services/market/index.js';
import { authenticateRequest, requireAdmin } from '../services/auth/request-auth.js';
import { ServerConfigurationError } from '../services/errors.js';
import { isDatabaseConnected } from '../config/database.js';
import { resolveAiConfig } from '../services/ai/config.js';
import { hasOpenAiKey } from '../services/ai/openai-key.js';
import { env } from '../config/env.js';
import { isMailConfigured } from '../services/mailer.js';
import { createLogger, errorName } from '../services/logger.js';

const log = createLogger('market');

/**
 * Reports which optional integrations are configured, without leaking values,
 * plus the configured models and deployed commit.
 */
export async function health(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireMethod(req, res, 'GET')) return;
  // Load balancers and Docker must see an outage, not a cheerful "ok".
  if (!isDatabaseConnected()) {
    res.status(503).json({ status: 'unavailable', integrations: { database: false } });
    return;
  }
  const models = await resolveAiConfig();
  res.status(200).json({
    status: 'ok',
    commit: process.env.GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    model: models.analysisModel,
    fastModel: models.fastModel,
    integrations: {
      openai: hasOpenAiKey(),
      database: isDatabaseConnected(),
      kite: isKiteConfigured(),
      google: env.googleAuthEnabled,
      email: isMailConfigured(),
    },
  });
}

function marketFailure(res, error, label) {
  if (error instanceof MarketDataError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof ServerConfigurationError) {
    res.status(503).json({ error: 'Market data is not configured.' });
    return;
  }
  if (
    error instanceof Error &&
    'status' in error &&
    (error.status === 401 || error.status === 403)
  ) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof Error && 'status' in error && error.status === 409) {
    res.status(409).json({ error: error.message });
    return;
  }
  log.error('unexpected failure', { endpoint: label, error: errorName(error) });
  res.status(500).json({ error: 'Unexpected server error' });
}

/** GET /api/quote?symbol=: the signed-in member's quote for one symbol. 503 without a database. */
export async function quote(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }
  try {
    if (!isDatabaseConnected())
      throw new ServerConfigurationError('Market data is not configured.');
    // Validate before authentication or provider selection can make a request.
    // Passing the raw value also rejects repeated query parameters.
    const symbol = assertValidSymbol(req.query?.symbol);
    const { user } = await authenticateRequest(req);
    res.status(200).json(await getQuote(symbol, user.id));
  } catch (error) {
    marketFailure(res, error, 'quote');
  }
}

/**
 * GET /api/history?symbol=&from=&to=&interval=: price bars for a symbol. The whole query is
 * validated before authentication; intraday intervals have a bounded range.
 */
export async function history(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return;
  }
  try {
    if (!isDatabaseConnected())
      throw new ServerConfigurationError('Market data is not configured.');
    // Validate the complete request before touching auth or market providers.
    const symbol = assertValidSymbol(req.query?.symbol);
    const from = assertValidDate(req.query?.from, 'from');
    const to = assertValidDate(req.query?.to, 'to');
    const interval = assertValidInterval(req.query?.interval);
    assertValidHistoryRange(from, to);
    assertBoundedIntradayRange(from, to, interval);
    const { user } = await authenticateRequest(req);
    res.status(200).json(await getHistory(symbol, from, to, interval, user.id));
  } catch (error) {
    marketFailure(res, error, 'history');
  }
}

/**
 * Explicitly rebuilds the instrument master. The lazy refresh on a symbol miss
 * covers the normal case; administrators can force a reload after a listing change.
 */
export async function refreshInstrumentMaster(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  try {
    await requireAdmin(req);
    const loaded = await refreshInstruments();
    res.status(200).json({ loaded, total: await instrumentCount() });
  } catch (error) {
    const status = error instanceof MarketDataError || error?.status ? Number(error.status) : 500;
    res.status(status).json({
      error: status < 500 || error instanceof MarketDataError ? error.message : 'Unexpected error',
    });
  }
}
