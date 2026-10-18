/**
 * Upstox (API v2) connection over OAuth, used read-only to bring today's fills
 * into the journal. The platform app keys come from UPSTOX_API_KEY and
 * UPSTOX_API_SECRET; the redirect URI <APP_URL origin>/api/upstox/callback is
 * registered in the Upstox developer console. The access token is stored
 * encrypted and lapses at 03:30 IST the next day.
 */
import { HttpError } from '../errors.js';
import {
  brokerMessage,
  brokerRequest,
  brokerRows,
  brokerTokenStatus,
  nextIstTime,
  saveBrokerToken,
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

const LABEL = 'Upstox';
const API_BASE = 'https://api.upstox.com/v2';
const REJECTED = 'Upstox rejected the login. Connect Upstox again.';
const FORMATS = ['kite', 'spaced'];
/** Upstox exchange names (and instrument-key segments) → the journal's exchanges. */
const EXCHANGES = {
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO',
  BFO: 'BFO',
  NSE_EQ: 'NSE',
  BSE_EQ: 'BSE',
  NSE_FO: 'NFO',
  BSE_FO: 'BFO',
};

/** Whether the server has Upstox app keys and a valid APP_URL for the redirect. */
export function upstoxConfigured() {
  return Boolean(
    process.env.UPSTOX_API_KEY?.trim() &&
    process.env.UPSTOX_API_SECRET?.trim() &&
    callbackUrl('upstox'),
  );
}

/** The Upstox login page for this state. */
export function upstoxAuthorizeUrl(state) {
  const url = new URL(`${API_BASE}/login/authorization/dialog`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.UPSTOX_API_KEY.trim());
  url.searchParams.set('redirect_uri', callbackUrl('upstox'));
  url.searchParams.set('state', state);
  return url.toString();
}

/** Connection state for Settings (whether app keys exist, never the keys or the token). */
export async function upstoxStatus(userId) {
  return { configured: upstoxConfigured(), ...(await brokerTokenStatus(userId, 'upstox')) };
}

/** Exchanges the callback's authorization code for an access token and stores it encrypted. */
export async function connectUpstox(userId, code) {
  if (!upstoxConfigured())
    throw new HttpError('The administrator has not set Upstox app keys yet.', 503);
  if (typeof code !== 'string' || !/^[A-Za-z0-9_.-]{1,512}$/.test(code)) {
    throw new HttpError('Upstox did not return a login code. Start again.', 400);
  }
  let payload;
  try {
    payload = await brokerRequest(LABEL, `${API_BASE}/login/authorization/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.UPSTOX_API_KEY.trim(),
        client_secret: process.env.UPSTOX_API_SECRET.trim(),
        redirect_uri: callbackUrl('upstox'),
        grant_type: 'authorization_code',
      }),
      rejected: 'Upstox did not accept the login. Start again.',
    });
  } catch (error) {
    const reason = brokerMessage(error.body);
    if (reason) throw new HttpError(`Upstox did not accept the login: ${reason}`, 502);
    throw error;
  }
  const token = payload?.access_token;
  const brokerUserId = payload?.user_id;
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_.-]{20,4096}$/.test(token) ||
    typeof brokerUserId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(brokerUserId)
  ) {
    throw new HttpError('Upstox did not return a valid account connection.', 502);
  }
  await saveBrokerToken(userId, 'upstox', LABEL, {
    token,
    brokerUserId,
    expiresAt: nextIstTime(3, 30),
  });
  return upstoxStatus(userId);
}

/** Upstox product codes → the journal's: intraday, delivery (CNC for equity, NRML for F&O). */
function product(code, exchange) {
  const value = String(code ?? '').toUpperCase();
  if (value === 'I') return 'MIS';
  if (value === 'D') return exchange === 'NFO' || exchange === 'BFO' ? 'NRML' : 'CNC';
  return value || 'CNC';
}

function instrument(row) {
  const rawSymbol = row.trading_symbol ?? row.tradingsymbol;
  const exchange =
    EXCHANGES[String(row.exchange ?? '').toUpperCase()] ?? String(row.exchange ?? '');
  return { rawSymbol, exchange, ...instrumentSymbol(LABEL, exchange, rawSymbol, FORMATS) };
}

/** Maps Upstox "trades for the day" rows to fills; unreadable rows come back in `skipped`. */
export function upstoxTradesToFills(trades, tradingDate) {
  return rowsToFills(
    trades.map((row) => {
      const { rawSymbol, exchange, symbol, problem } = instrument(row);
      return {
        rawSymbol,
        exchange,
        symbol,
        problem,
        product: product(row.product, exchange),
        side: String(row.transaction_type ?? '').toUpperCase(),
        quantity: row.quantity,
        price: row.average_price,
        tradeId: row.trade_id,
        orderId: row.order_id,
        filledAt:
          istToIso(row.exchange_timestamp, tradingDate) ??
          istToIso(row.order_timestamp, tradingDate),
      };
    }),
    tradingDate,
  );
}

/** Quantities held before today: overnight positions and delivery holdings (with T1). */
export function upstoxCarried(positions, holdings) {
  const carried = new Map();
  for (const row of positions) {
    const { exchange, symbol } = instrument(row);
    const code = product(row.product, exchange);
    // Delivery equity carried in shows up in holdings (T1) instead.
    if (!symbol || code === 'CNC') continue;
    const overnight =
      row.overnight_quantity !== undefined && row.overnight_quantity !== null
        ? Number(row.overnight_quantity)
        : Number(row.overnight_buy_quantity ?? 0) - Number(row.overnight_sell_quantity ?? 0);
    addCarried(carried, `${exchange}:${symbol}:${code}`, overnight);
  }
  for (const row of holdings) {
    addHolding(
      carried,
      equitySymbol(row.trading_symbol ?? row.tradingsymbol),
      Number(row.quantity ?? 0) + Number(row.t1_quantity ?? 0),
    );
  }
  return carried;
}

async function upstoxList(token, path, what) {
  const payload = await brokerRequest(LABEL, `${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    rejected: REJECTED,
  });
  if (payload?.status !== 'success')
    throw new HttpError(`Upstox returned an invalid ${what}.`, 502);
  return brokerRows(LABEL, payload.data, what);
}

/** Today's Upstox fills in the snapshot shape the fills journal reads. */
export function readUpstoxFills(userId) {
  return withBrokerToken(userId, 'upstox', LABEL, async (token) => {
    const fetchedAt = new Date().toISOString();
    const tradingDate = brokerTradingDate(Date.parse(fetchedAt));
    const [trades, positions, holdings] = await Promise.all([
      upstoxList(token, '/order/trades/get-trades-for-day', 'trade book'),
      upstoxList(token, '/portfolio/short-term-positions', 'position list'),
      upstoxList(token, '/portfolio/long-term-holdings', 'holding list'),
    ]);
    const { fills, skipped } = upstoxTradesToFills(trades, tradingDate);
    return {
      tradingDate,
      fetchedAt,
      trades: fills,
      skipped,
      carried: upstoxCarried(positions, holdings),
    };
  });
}
