/**
 * Angel One (SmartAPI) connection: brings today's fills into the journal and
 * serves the broker adapter (adapters/angel.js), which alone places orders.
 * There is no platform app: the member gives their own SmartAPI
 * API key, client code, PIN and current authenticator (TOTP) code. Only the
 * API key and the session JWT are kept (encrypted, until midnight IST); the
 * PIN and TOTP are sent to Angel One once and never stored or logged.
 */
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
import { brokerTradingDate } from './portfolio.js';

const LABEL = 'Angel One';
const API_BASE = 'https://apiconnect.angelone.in/rest';
const REJECTED = 'Angel One ended the session. Log in to Angel One again.';
/** SmartAPI error codes for an invalid or expired session token. */
const TOKEN_CODES = new Set(['AG8001', 'AG8002', 'AG8003']);

/**
 * SmartAPI's required client headers. It asks for the caller's IP and MAC
 * address; the server has no honest value for the member's device, so fixed
 * placeholders are sent (the session is tied to the API key, not these).
 */
function headers(apiKey, jwt) {
  return {
    'Content-Type': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

/** Connection state for Settings; Angel One needs no server keys. */
export async function angelStatus(userId) {
  return { configured: true, ...(await brokerTokenStatus(userId, 'angel')) };
}

/** Logs in to SmartAPI with the member's details and stores the session encrypted. */
export async function connectAngel(userId, input) {
  const apiKey = String(input?.apiKey ?? '').trim();
  const clientCode = String(input?.clientCode ?? '')
    .trim()
    .toUpperCase();
  const pin = String(input?.pin ?? '').trim();
  const totp = String(input?.totp ?? '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(apiKey))
    throw new HttpError('Enter your SmartAPI API key (smartapi.angelbroking.com → My apps).', 400);
  if (!/^[A-Z0-9]{2,20}$/.test(clientCode))
    throw new HttpError('Enter your Angel One client code.', 400);
  if (!/^\d{4,8}$/.test(pin)) throw new HttpError('Enter your Angel One PIN.', 400);
  if (!/^\d{6}$/.test(totp))
    throw new HttpError('Enter the current 6-digit code from your authenticator app.', 400);
  let payload;
  try {
    payload = await brokerRequest(LABEL, `${API_BASE}/auth/angelbroking/user/v1/loginByPassword`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ clientcode: clientCode, password: pin, totp }),
      rejected: 'Angel One did not accept the API key. Check it and try again.',
    });
  } catch (error) {
    const reason = brokerMessage(error.body);
    if (reason) throw new HttpError(`Angel One did not accept the login: ${reason}`, 400);
    throw error;
  }
  const jwt = String(payload?.data?.jwtToken ?? '').replace(/^Bearer /, '');
  if (payload?.status !== true || !/^[A-Za-z0-9_.-]{20,4096}$/.test(jwt)) {
    const reason = brokerMessage(payload);
    throw new HttpError(
      reason
        ? `Angel One did not accept the login: ${reason}`
        : 'Angel One did not return a session.',
      reason ? 400 : 502,
    );
  }
  await saveBrokerToken(userId, 'angel', LABEL, {
    token: JSON.stringify({ apiKey, jwt }),
    brokerUserId: clientCode,
    expiresAt: nextIstTime(0, 0),
  });
  return angelStatus(userId);
}

/** SmartAPI product types → the journal's: intraday, delivery, F&O carry-forward. */
export function angelProduct(type) {
  const value = String(type ?? '').toUpperCase();
  return { INTRADAY: 'MIS', DELIVERY: 'CNC', CARRYFORWARD: 'NRML' }[value] ?? (value || 'CNC');
}

function instrument(row) {
  const rawSymbol = row.tradingsymbol;
  const exchange = String(row.exchange ?? '').toUpperCase();
  return { rawSymbol, exchange, ...instrumentSymbol(LABEL, exchange, rawSymbol, ['dated']) };
}

/** Maps SmartAPI trade-book rows to fills; unreadable rows come back in `skipped`. */
export function angelTradesToFills(trades, tradingDate) {
  return rowsToFills(
    trades.map((row) => ({
      ...instrument(row),
      product: angelProduct(row.producttype),
      side: String(row.transactiontype ?? '').toUpperCase(),
      quantity: row.fillsize,
      price: row.fillprice,
      tradeId: row.fillid,
      orderId: row.orderid,
      filledAt: istToIso(row.filltime, tradingDate),
    })),
    tradingDate,
  );
}

/** Quantities held before today: carry-forward positions and delivery holdings (with T1). */
export function angelCarried(positions, holdings) {
  const carried = new Map();
  for (const row of positions) {
    const { exchange, symbol, problem } = instrument(row);
    const code = angelProduct(row.producttype);
    if (!symbol || problem || code === 'CNC') continue;
    addCarried(
      carried,
      `${exchange}:${symbol}:${code}`,
      Number(row.cfbuyqty ?? 0) - Number(row.cfsellqty ?? 0),
    );
  }
  for (const row of holdings) {
    addHolding(
      carried,
      equitySymbol(row.tradingsymbol),
      Number(row.quantity ?? 0) + Number(row.t1quantity ?? 0),
    );
  }
  return carried;
}

/**
 * One SmartAPI call with the member's `session` ({ apiKey, jwt }); returns the parsed reply. An
 * ended session (HTTP 401/403 or a token error code) throws tokenRejectedError.
 */
export async function angelRequest(session, path, { method = 'GET', body } = {}) {
  const payload = await brokerRequest(LABEL, `${API_BASE}/secure/angelbroking${path}`, {
    method,
    headers: headers(session.apiKey, session.jwt),
    body: body === undefined ? undefined : JSON.stringify(body),
    rejected: REJECTED,
  });
  if (TOKEN_CODES.has(String(payload?.errorcode ?? payload?.errorCode ?? '')))
    throw tokenRejectedError(REJECTED);
  return payload;
}

/** The `data` of a read-only SmartAPI GET; 502 unless Angel One reports success. */
export async function angelData(session, path, what) {
  const payload = await angelRequest(session, path);
  if (payload?.status !== true && payload?.success !== true)
    throw new HttpError(`Angel One returned an invalid ${what}.`, 502);
  return payload.data;
}

/** The rows of a read-only SmartAPI list (trade book, positions, holdings, order book). */
export async function angelList(session, path, what) {
  return brokerRows(LABEL, await angelData(session, path, what), what);
}

/** Today's Angel One fills in the snapshot shape the fills journal reads. */
export function readAngelFills(userId) {
  return withBrokerToken(userId, 'angel', LABEL, async (stored) => {
    const session = JSON.parse(stored);
    const fetchedAt = new Date().toISOString();
    const tradingDate = brokerTradingDate(Date.parse(fetchedAt));
    const [trades, positions, holdings] = await Promise.all([
      angelList(session, '/order/v1/getTradeBook', 'trade book'),
      angelList(session, '/order/v1/getPosition', 'position list'),
      angelList(session, '/portfolio/v1/getHolding', 'holding list'),
    ]);
    const { fills, skipped } = angelTradesToFills(trades, tradingDate);
    return {
      tradingDate,
      fetchedAt,
      trades: fills,
      skipped,
      carried: angelCarried(positions, holdings),
    };
  });
}
