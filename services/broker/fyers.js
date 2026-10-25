/**
 * Fyers (API v3) connection over OAuth, used to bring today's fills into the
 * journal and, through adapters/fyers.js, for the portfolio, balance and live
 * orders. The platform app comes from FYERS_APP_ID (like XXXX-100)
 * and FYERS_SECRET_ID; the redirect URI <APP_URL origin>/api/fyers/callback is
 * registered with the app. Fyers tokens last the trading day; ours is treated
 * as expired at 05:00 IST, before Fyers' own early-morning cut-off.
 */
import { createHash } from 'node:crypto';
import { HttpError } from '../errors.js';
import {
  brokerMessage,
  brokerRequest,
  brokerRows,
  brokerTokenStatus,
  nextIstTime,
  saveBrokerToken,
  tokenRejectedError,
  withBrokerToken,
} from './broker-api.js';
import {
  addCarried,
  addHolding,
  equitySymbol,
  instrumentSymbol,
  istToIso,
  rowsToFills,
} from './fill-mapping.js';
import { callbackUrl } from './oauth.js';
import { brokerTradingDate } from './portfolio.js';

const LABEL = 'Fyers';
const API_BASE = 'https://api-t1.fyers.in/api/v3';
const REJECTED = 'Fyers rejected the login. Connect Fyers again.';
/** Fyers error codes for an invalid, expired or unauthenticated token. */
const TOKEN_CODES = new Set([-8, -15, -16, -17]);
/** Fyers segment codes: 10 cash, 11 equity derivatives (others are not journaled). */
const CASH = 10;
const DERIVATIVES = 11;

const appId = () => process.env.FYERS_APP_ID?.trim() ?? '';

/** Whether the server has Fyers app keys and a valid APP_URL for the redirect. */
export function fyersConfigured() {
  return Boolean(appId() && process.env.FYERS_SECRET_ID?.trim() && callbackUrl('fyers'));
}

/** The Fyers login page for this state. */
export function fyersAuthorizeUrl(state) {
  const url = new URL(`${API_BASE}/generate-authcode`);
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', callbackUrl('fyers'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

/** SHA-256 of "<app id>:<secret>", which Fyers takes instead of the secret itself. */
export function fyersAppIdHash() {
  return createHash('sha256')
    .update(`${appId()}:${process.env.FYERS_SECRET_ID?.trim() ?? ''}`)
    .digest('hex');
}

/** Connection state for Settings (whether app keys exist, never the keys or the token). */
export async function fyersStatus(userId) {
  return { configured: fyersConfigured(), ...(await brokerTokenStatus(userId, 'fyers')) };
}

/** The Fyers client ID from the token's JWT payload, when present (Fyers does not return it). */
function tokenClientId(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    const id = payload?.fy_id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Exchanges the callback's auth code for an access token and stores it encrypted. */
export async function connectFyers(userId, code) {
  if (!fyersConfigured())
    throw new HttpError('The administrator has not set Fyers app keys yet.', 503);
  if (typeof code !== 'string' || !/^[A-Za-z0-9_.-]{1,4096}$/.test(code)) {
    throw new HttpError('Fyers did not return a login code. Start again.', 400);
  }
  let payload;
  try {
    payload = await brokerRequest(LABEL, `${API_BASE}/validate-authcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash: fyersAppIdHash(), code }),
      rejected: 'Fyers did not accept the login. Start again.',
    });
  } catch (error) {
    const reason = brokerMessage(error.body);
    if (reason) throw new HttpError(`Fyers did not accept the login: ${reason}`, 502);
    throw error;
  }
  const token = payload?.access_token;
  if (
    payload?.s !== 'ok' ||
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_.-]{20,4096}$/.test(token)
  ) {
    const reason = brokerMessage(payload);
    throw new HttpError(
      reason
        ? `Fyers did not accept the login: ${reason}`
        : 'Fyers did not return a valid account connection.',
      502,
    );
  }
  await saveBrokerToken(userId, 'fyers', LABEL, {
    token,
    brokerUserId: tokenClientId(token),
    expiresAt: nextIstTime(5, 0),
  });
  return fyersStatus(userId);
}

/** Fyers product types → the journal's: intraday, delivery, F&O carry-forward. */
function product(type) {
  const value = String(type ?? '').toUpperCase();
  return { INTRADAY: 'MIS', CNC: 'CNC', MARGIN: 'NRML' }[value] ?? (value || 'CNC');
}

/** "NSE:SBIN-EQ" / "NSE:NIFTY26OCTFUT" → exchange and journal symbol (or a reason to skip). */
function instrument(row) {
  const rawSymbol = String(row.symbol ?? '');
  const [prefix, body = ''] = rawSymbol.toUpperCase().split(':');
  const segment =
    row.segment === undefined || row.segment === null
      ? /(FUT|\d(?:CE|PE))$/.test(body) && !body.includes('-')
        ? DERIVATIVES
        : CASH
      : Number(row.segment);
  if (!['NSE', 'BSE'].includes(prefix) || ![CASH, DERIVATIVES].includes(segment)) {
    // Currency and commodity rows: shared/broker-fills.js skips this exchange with its reason.
    return {
      rawSymbol,
      exchange: `${prefix || 'UNKNOWN'}-${segment}`,
      symbol: body || rawSymbol,
      problem: null,
    };
  }
  const exchange = segment === CASH ? prefix : prefix === 'NSE' ? 'NFO' : 'BFO';
  return { rawSymbol, exchange, ...instrumentSymbol(LABEL, exchange, body, ['kite']) };
}

/** Maps Fyers tradebook rows to fills; unreadable rows come back in `skipped`. */
export function fyersTradesToFills(trades, tradingDate) {
  return rowsToFills(
    trades.map((row) => {
      const side = Number(row.side);
      return {
        ...instrument(row),
        product: product(row.productType),
        side: side === 1 ? 'BUY' : side === -1 ? 'SELL' : null,
        quantity: row.tradedQty,
        price: row.tradePrice,
        tradeId: row.tradeNumber,
        orderId: row.orderNumber,
        filledAt: istToIso(row.orderDateTime, tradingDate),
      };
    }),
    tradingDate,
  );
}

/** Quantities held before today: carry-forward positions and delivery holdings. */
export function fyersCarried(positions, holdings) {
  const carried = new Map();
  for (const row of positions) {
    const { exchange, symbol, problem } = instrument(row);
    const code = product(row.productType);
    if (!symbol || problem || code === 'CNC') continue;
    addCarried(
      carried,
      `${exchange}:${symbol}:${code}`,
      Number(row.cfBuyQty ?? 0) - Number(row.cfSellQty ?? 0),
    );
  }
  for (const row of holdings) {
    addHolding(
      carried,
      equitySymbol(row.symbol),
      Number(row.quantity ?? row.remainingQuantity ?? 0),
    );
  }
  return carried;
}

/** Row mapping shared with the broker adapter (adapters/fyers.js). */
export { instrument as fyersInstrument, product as fyersProduct };

/**
 * Calls a Fyers path with the member's token: a GET, or a POST of `body` as JSON. A reply with a
 * token error code throws tokenRejectedError; any other reply is returned as it is.
 */
export async function fyersRequest(token, path, body) {
  const payload = await brokerRequest(LABEL, `${API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `${appId()}:${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
    rejected: REJECTED,
  });
  if (payload?.s !== 'ok' && TOKEN_CODES.has(Number(payload?.code))) {
    throw tokenRejectedError(REJECTED);
  }
  return payload;
}

/** The `field` rows of a Fyers GET (see brokerRows); a reply that is not ok is 502. */
export async function fyersList(token, path, field, what) {
  const payload = await fyersRequest(token, path);
  if (payload?.s !== 'ok') throw new HttpError(`Fyers returned an invalid ${what}.`, 502);
  return brokerRows(LABEL, payload[field], what);
}

/** Today's Fyers fills in the snapshot shape the fills journal reads. */
export function readFyersFills(userId) {
  return withBrokerToken(userId, 'fyers', LABEL, async (token) => {
    if (!appId()) throw new HttpError('The administrator has not set Fyers app keys yet.', 503);
    const fetchedAt = new Date().toISOString();
    const tradingDate = brokerTradingDate(Date.parse(fetchedAt));
    const [trades, positions, holdings] = await Promise.all([
      fyersList(token, '/tradebook', 'tradeBook', 'trade book'),
      fyersList(token, '/positions', 'netPositions', 'position list'),
      fyersList(token, '/holdings', 'holdings', 'holding list'),
    ]);
    const { fills, skipped } = fyersTradesToFills(trades, tradingDate);
    return {
      tradingDate,
      fetchedAt,
      trades: fills,
      skipped,
      carried: fyersCarried(positions, holdings),
    };
  });
}
