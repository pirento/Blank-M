/**
 * Browser client for quotes, price history and the Zerodha connection endpoints.
 */
import { api, ApiError, requestHeaders } from '../core/api.js';

/**
 * Client for the server's market-data and broker endpoints. Requests carry the
 * session cookie, so the server can use this user's broker session when one
 * exists and fall back automatically when it does not.
 */
export class MarketDataError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MarketDataError';
    this.status = status;
  }
}

async function getJson(url, options = {}) {
  try {
    return await api(url, options);
  } catch (error) {
    if (error instanceof ApiError) throw new MarketDataError(error.message, error.status);
    throw new MarketDataError('Could not reach the server.', 0);
  }
}

/** Promise of the latest quote for a symbol (trimmed, upper-cased) from /api/quote. */
export async function fetchQuote(symbol, signal) {
  return getJson(`/api/quote?symbol=${encodeURIComponent(symbol.trim().toUpperCase())}`, {
    signal,
  });
}

/** Promise of candles for `{ symbol, from, to, interval = '1d' }`; [] when the payload has none. */
export async function fetchHistory(request, signal) {
  const params = new URLSearchParams({
    symbol: request.symbol.trim().toUpperCase(),
    from: request.from,
    to: request.to,
    interval: request.interval ?? '1d',
  });
  const payload = await getJson(`/api/history?${params.toString()}`, { signal });
  return Array.isArray(payload?.candles) ? payload.candles : [];
}

/** Promise of the Zerodha connection status from /api/kite/status. */
export async function fetchBrokerStatus() {
  return getJson('/api/kite/status');
}

/** Returns the Zerodha authorization URL; redirecting stays a user gesture. */
export async function startBrokerConnect() {
  const { url } = await getJson('/api/kite/authorize', { method: 'POST', body: {} });
  return url;
}

/** Confirms the pending connection from the server's HttpOnly pending cookie. */
export async function completeBrokerConnect() {
  const payload = await getJson('/api/kite/complete', { method: 'POST', body: {} });
  if (!payload || payload.connected !== true) {
    throw new MarketDataError('Zerodha connection was not confirmed.', 502);
  }
}

/** Promise of the live Zerodha INR balance payload; throws if any field fails validation. */
export async function fetchBrokerBalance() {
  const payload = await getJson('/api/kite/balance', { timeout: 30_000 });
  if (
    payload?.source !== 'kite' ||
    payload.currency !== 'INR' ||
    typeof payload.liveBalance !== 'number' ||
    !Number.isFinite(payload.liveBalance) ||
    Math.abs(payload.liveBalance) * 100 > Number.MAX_SAFE_INTEGER ||
    typeof payload.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.fetchedAt))
  )
    throw new Error('Broker balance response was invalid.');
  return payload;
}

/** Disconnect Zerodha via POST /api/kite/disconnect; throws unless the reply confirms it. */
export async function disconnectBrokerSession(signal) {
  const payload = await getJson('/api/kite/disconnect', { method: 'POST', body: {}, signal });
  if (!payload || payload.connected !== false || typeof payload.identityRetained !== 'boolean') {
    throw new Error('The disconnection outcome could not be verified. Refresh broker status.');
  }
  return payload;
}

function statusError(status) {
  if (status === 401) return 'Sign in again before refreshing broker records.';
  if (status === 403) return 'Your account cannot read broker records. Check workspace access.';
  if (status === 409)
    return 'Connect or reconnect Zerodha in Settings, then refresh broker records.';
  if (status === 429) return 'Too many broker requests. Wait a moment, then refresh again.';
  if (status === 503) return 'Broker access is not configured or is temporarily unavailable.';
  return 'Could not read a complete broker snapshot. Try refreshing again.';
}

const PORTFOLIO_MAX_BYTES = 4 * 1024 * 1024;

/** A user-triggered portfolio read with a bounded body and no browser cache. */
export async function fetchBrokerPortfolio(schema, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Broker refresh timed out. Try again.')),
    30_000,
  );
  try {
    const response = await fetch('/api/kite/portfolio', {
      headers: requestHeaders(false),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(statusError(response.status));
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > PORTFOLIO_MAX_BYTES)
      throw new Error('Broker response is too large to display safely.');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > PORTFOLIO_MAX_BYTES)
      throw new Error('Broker response is too large to display safely.');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Broker records could not be verified. Try refreshing again.');
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new Error('Broker records could not be verified. Try refreshing again.');
    return parsed.data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
