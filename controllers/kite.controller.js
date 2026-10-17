/**
 * Zerodha Kite endpoints: start and complete the broker login, connection
 * status, balance, read-only portfolio, today's fills as journal trades and
 * disconnect.
 */
import {
  MarketDataError,
  buildAuthorizeUrl,
  connectionStatus,
  exchangeRequestToken,
  isKiteConfigured,
  saveConnection,
} from '../services/market/index.js';
import { disconnectBrokerSession, readBrokerBalance } from '../services/market/kite.js';
import { readBrokerPortfolio } from '../services/broker/portfolio.js';
import { importFills, previewFills } from '../services/broker/fills-journal.js';
import {
  beginBrokerFlow,
  brokerConfiguration,
  brokerError,
  clearBrokerCookies,
  consumePendingBrokerResult,
  requireBrokerMethod,
  requireBrokerOrigin,
  stageBrokerCallback,
} from '../services/broker/flow.js';
import { authenticateRequest } from '../services/auth/request-auth.js';
import { validateAppSession } from '../services/auth/app-sessions.js';
import { HttpError, ServerConfigurationError } from '../services/errors.js';

function readFailure(res, error, fallback) {
  const status =
    error instanceof MarketDataError
      ? error.status
      : error instanceof ServerConfigurationError
        ? 503
        : error instanceof Error &&
            'status' in error &&
            [401, 403, 409].includes(Number(error.status))
          ? Number(error.status)
          : 500;
  res.status(status).json({
    error:
      error instanceof MarketDataError || (status < 500 && error instanceof Error)
        ? error.message
        : fallback,
  });
}

function getOnly(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed. Use GET.' });
    return false;
  }
  return true;
}

/**
 * POST /api/kite/authorize: starts the Zerodha login for this browser and returns the Kite login
 * URL.
 */
export async function authorize(req, res) {
  if (!requireBrokerMethod(req, res, 'POST')) return;
  try {
    requireBrokerOrigin(req);
    if (!isKiteConfigured()) throw new MarketDataError('Zerodha Kite is not configured.', 503);
    res.status(200).json({ url: buildAuthorizeUrl(await beginBrokerFlow(req, res)) });
  } catch (error) {
    brokerError(res, error);
  }
}

/**
 * GET /api/kite/callback: Zerodha's redirect. Stages the request token in a cookie and sends
 * the browser to /settings?kite=pending (or kite=failed); POST /api/kite/complete finishes it.
 */
export async function callback(req, res) {
  if (!requireBrokerMethod(req, res, 'GET')) return;
  let origin;
  try {
    origin = brokerConfiguration().origin;
  } catch (error) {
    brokerError(res, error);
    return;
  }
  try {
    await stageBrokerCallback(req, res);
    res.redirect(`${origin}/settings?kite=pending`);
  } catch {
    res.redirect(`${origin}/settings?kite=failed`);
  }
}

/**
 * POST /api/kite/complete: exchanges the staged request token and saves the connection for the
 * same member and session that started the flow. Same-origin requests only.
 */
export async function complete(req, res) {
  if (!requireBrokerMethod(req, res, 'POST')) return;
  // A cross-origin request must not be able to clear a legitimate browser's flow.
  try {
    requireBrokerOrigin(req);
  } catch (error) {
    brokerError(res, error);
    return;
  }
  clearBrokerCookies(res);
  try {
    const pending = await consumePendingBrokerResult(req);
    await saveConnection(
      pending.userId,
      pending.sessionId,
      pending.authorizationExpiresAt,
      await exchangeRequestToken(pending.requestToken),
    );
    res.status(200).json({ connected: true });
  } catch (error) {
    brokerError(res, error);
  }
}

/** GET /api/kite/status: whether Kite is configured and the member's connection status. */
export async function status(req, res) {
  if (!getOnly(req, res)) return;
  if (!isKiteConfigured()) {
    res.status(200).json({
      configured: false,
      connected: false,
      expiresAt: null,
      instruments: 0,
      provider: 'kite',
    });
    return;
  }
  try {
    const { user } = await authenticateRequest(req);
    res.status(200).json(await connectionStatus(user.id));
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error &&
      'status' in error &&
      [401, 403, 503].includes(Number(error.status))
        ? Number(error.status)
        : 500;
    res.status(code).json({
      error: code < 500 && error instanceof Error ? error.message : 'Could not read broker status.',
    });
  }
}

/** Read only; never changes funds, settings or broker positions. */
export async function balance(req, res) {
  if (!getOnly(req, res)) return;
  try {
    const { user } = await authenticateRequest(req);
    res.status(200).json(await readBrokerBalance(user.id));
  } catch (error) {
    readFailure(
      res,
      error,
      'Broker balance is unavailable. Verify the connection and server configuration.',
    );
  }
}

/** Read-only private account snapshot; request bodies and query owner IDs are never trusted. */
export async function portfolio(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!getOnly(req, res)) return;
  try {
    const { auth, assertAccess } = await sessionGuard(req);
    const snapshot = await readBrokerPortfolio(auth.user.id, assertAccess);
    await assertAccess();
    res.status(200).json(snapshot);
  } catch (error) {
    readFailure(res, error, 'Broker records are unavailable. Verify the connection and try again.');
  }
}

/**
 * The member and a check that re-verifies membership, factors and the login
 * session; called again after every asynchronous provider step.
 */
async function sessionGuard(req) {
  const auth = await authenticateRequest(req);
  const sessionId = auth.session.sessionId;
  const assertAccess = async () => {
    const current = await authenticateRequest(req);
    if (current.user.id !== auth.user.id || current.token !== auth.token) {
      throw new MarketDataError('Your app session changed. Sign in again.', 401);
    }
    let active;
    try {
      active = await validateAppSession(auth.user.id, sessionId);
    } catch {
      throw new MarketDataError('The app session could not be checked.', 503);
    }
    if (!active)
      throw new MarketDataError('Your app session is no longer active. Sign in again.', 401);
  };
  await assertAccess();
  return { auth, assertAccess };
}

/** GET /api/kite/fills: today's fills paired into round trips, not yet saved. */
export async function fills(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!getOnly(req, res)) return;
  try {
    const { auth, assertAccess } = await sessionGuard(req);
    res.status(200).json(await previewFills(auth.user.id, assertAccess));
  } catch (error) {
    readFailure(res, error, 'Zerodha fills are unavailable. Verify the connection and try again.');
  }
}

/** POST /api/kite/fills/import { ids }: adds the chosen round trips to the journal. */
export async function importFillsToJournal(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }
  try {
    const { auth, assertAccess } = await sessionGuard(req);
    res.status(200).json(await importFills(auth.user.id, assertAccess, req.body?.ids));
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      res.status(400).json({ error: error.message });
      return;
    }
    readFailure(res, error, 'The fills could not be added. Verify the connection and try again.');
  }
}

/** Revoke only this app's stored broker session; never delete the account binding. */
export async function disconnect(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }
  try {
    const { user } = await authenticateRequest(req);
    res.status(200).json(await disconnectBrokerSession(user.id));
  } catch (error) {
    readFailure(
      res,
      error,
      'Could not verify disconnection. Refresh broker status before trying again.',
    );
  }
}
