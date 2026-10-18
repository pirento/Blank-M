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
import { subscribeLiveQuotes } from '../services/market/kite/ticker.js';

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

/* --------------------------------- live quotes --------------------------------- */

const MAX_STREAMS_PER_MEMBER = 5;
/** Open live quote streams, ended on shutdown so a reload is not held up by them. */
const streams = new Set();

/** Ends every live quote stream (browsers reconnect on their own). */
export function endLiveQuoteStreams() {
  for (const stream of streams) stream.end();
}

/**
 * GET /api/quotes/stream?symbols=A,B: Server-Sent Events with live Zerodha prices
 * (`data: {"symbol","price"}`, at most one per symbol per second). Without live data for this
 * member it sends one `event: unavailable` and ends, so the page stops asking and keeps its own
 * refresh (a non-stream answer would show up as a console error in the browser).
 */
export async function quoteStream(req, res) {
  const raw = String(req.query?.symbols ?? '');
  const symbols = raw.split(',').filter(Boolean).slice(0, 50).map(assertValidSymbol);
  const userId = req.member.userId;
  if (!symbols.length) return res.status(400).json({ error: 'Choose at least one symbol.' });
  const open = [...streams].filter((stream) => stream.userId === userId).length;
  if (open >= MAX_STREAMS_PER_MEMBER)
    return res.status(429).json({ error: 'Too many live pages.' });

  const lastSent = new Map();
  let unsubscribe = null;
  let ended = false;
  const stream = {
    userId,
    end: () => {
      if (ended) return;
      ended = true;
      streams.delete(stream);
      clearInterval(keepAlive);
      unsubscribe?.();
      res.end();
    },
  };
  // Proxies close idle connections; a comment every 25 s keeps the stream open.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  unsubscribe = await subscribeLiveQuotes(userId, symbols, {
    onTick: ({ symbol, price }) => {
      const now = Date.now();
      if (now - (lastSent.get(symbol) ?? 0) < 1000) return;
      lastSent.set(symbol, now);
      res.write(`data: ${JSON.stringify({ symbol, price })}\n\n`);
    },
    onEnd: () => stream.end(),
  });
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'private, no-store',
    Connection: 'keep-alive',
    // Nginx would otherwise buffer the stream.
    'X-Accel-Buffering': 'no',
  };
  if (!unsubscribe) {
    clearInterval(keepAlive);
    res.writeHead(200, headers);
    return res.end('event: unavailable\ndata: {}\n\n');
  }
  if (req.destroyed) return stream.end();
  streams.add(stream);
  res.writeHead(200, headers);
  // Browsers reconnect after this long when the stream ends (for example, Kite closed it).
  res.write('retry: 30000\n\n');
  req.on('close', () => stream.end());
}
