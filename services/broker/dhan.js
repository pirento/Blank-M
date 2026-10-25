/**
 * Dhan (DhanHQ v2) connection with a personal access token: today's fills for
 * the journal, and the request helpers of the Dhan broker adapter
 * (adapters/dhan.js, which also places orders). Dhan issues the token in its web
 * console (no OAuth app is needed); it is stored encrypted like Zerodha's and
 * is never sent back to the browser.
 */
import { BrokerConnection } from '../../models/index.js';
import { encryptSecret } from '../crypto.js';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';
import { MAX_ROWS, brokerRequest, decryptBrokerToken } from './broker-api.js';
import { brokerTradingDate } from './portfolio.js';
import { NSE_HOLIDAYS } from '../../shared/market.js';

const log = createLogger('dhan');
const API_BASE = 'https://api.dhan.co/v2';
const MAX_TRADES = MAX_ROWS;
const DEFAULT_VALIDITY_MS = 24 * 60 * 60_000;

/** Dhan exchange segments → exchanges the journal understands (others are skipped later). */
export const EXCHANGES = { NSE_EQ: 'NSE', BSE_EQ: 'BSE', NSE_FNO: 'NFO', BSE_FNO: 'BFO' };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Reads the client ID and expiry from the token's JWT payload when present.
 * The token is not trusted for this: Dhan's profile endpoint confirms it.
 */
export function dhanTokenClaims(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return {
      clientId: payload?.dhanClientId ? String(payload.dhanClientId) : null,
      expiresAt: Number.isFinite(payload?.exp) ? new Date(payload.exp * 1000) : null,
    };
  } catch {
    return { clientId: null, expiresAt: null };
  }
}

const REJECTED = 'Dhan rejected the access token. Create a new one and reconnect.';

/** A Dhan API GET; failures as brokerRequest throws them. */
export function dhanGet(path, token) {
  return brokerRequest('Dhan', `${API_BASE}${path}`, {
    headers: { 'access-token': token },
    rejected: REJECTED,
  });
}

/** A Dhan API POST of a JSON body; failures as brokerRequest throws them. */
export function dhanPost(path, token, body) {
  return brokerRequest('Dhan', `${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    rejected: REJECTED,
  });
}

/**
 * The member's demat holdings. Dhan answers an empty demat with its own error reply, and only
 * that means "no holdings": a timeout, rate limit or outage must not turn a delivery sale into a
 * short.
 */
export function dhanHoldings(token) {
  return dhanGet('/holdings', token).catch((error) => {
    const emptyDemat =
      error.body &&
      (error.body.errorCode === 'DH-1111' ||
        error.httpStatus < 500 ||
        /holding/i.test(JSON.stringify(error.body)));
    if (error.tokenRejected || !emptyDemat) throw error;
    log.info('dhan holdings empty', { error: errorName(error) });
    return [];
  });
}

async function loadToken(userId) {
  const row = await BrokerConnection.findOne({ userId, provider: 'dhan' }).lean();
  if (!row?.accessTokenCiphertext || row.expiresAt.getTime() <= Date.now()) return null;
  return { row, token: decryptBrokerToken(row) };
}

/**
 * The member's Dhan connection state (connected, expired, client ID, expiry and connect time);
 * never includes the token.
 */
export async function dhanStatus(userId) {
  const row = await BrokerConnection.findOne({ userId, provider: 'dhan' }).lean();
  const connected = Boolean(row?.accessTokenCiphertext) && row.expiresAt.getTime() > Date.now();
  return {
    connected,
    expired: Boolean(row?.accessTokenCiphertext) && !connected,
    clientId: row?.brokerUserId ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
  };
}

/** Verifies the token with Dhan's profile endpoint, then stores it encrypted. */
export async function connectDhan(userId, input) {
  const token = String(input?.accessToken ?? '').trim();
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw new HttpError(
      'Paste the access token from Dhan (web.dhan.co → My Profile → DhanHQ Trading APIs).',
      400,
    );
  }
  const claims = dhanTokenClaims(token);
  if (claims.expiresAt && claims.expiresAt.getTime() <= Date.now()) {
    throw new HttpError('That access token has already expired. Create a new one in Dhan.', 400);
  }
  const profile = await dhanGet('/profile', token);
  const clientId = profile?.dhanClientId ? String(profile.dhanClientId) : claims.clientId;
  if (!clientId) throw new HttpError('Dhan did not confirm the account for this token.', 502);
  const existing = await BrokerConnection.findOne({ userId, provider: 'dhan' }).lean();
  if (existing?.brokerUserId && existing.brokerUserId !== clientId) {
    throw new HttpError(
      `This journal is linked to Dhan client ${existing.brokerUserId}. Disconnect it first to link another account.`,
      409,
    );
  }
  const encrypted = encryptSecret(token);
  const expiresAt = claims.expiresAt ?? new Date(Date.now() + DEFAULT_VALIDITY_MS);
  await BrokerConnection.findOneAndUpdate(
    { userId, provider: 'dhan' },
    {
      $set: {
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        expiresAt,
        brokerUserId: clientId,
        connectedAt: new Date(),
      },
    },
    { upsert: true },
  );
  return dhanStatus(userId);
}

/** Forgets the token and the account binding. */
export async function disconnectDhan(userId) {
  await BrokerConnection.deleteOne({ userId, provider: 'dhan' });
  return dhanStatus(userId);
}

/** Kite's month letters in weekly option names: 1–9, then O, N, D. */
const WEEKLY_MONTHS = '123456789OND';

/**
 * Kite-style contract name so F&O fills are recognised: NIFTY26MAYFUT,
 * NIFTY26MAY24000CE (monthly expiry) or NIFTY2651424000CE (weekly, with the
 * day, so two expiries of one strike stay separate positions).
 */
export function contractSymbol(trade) {
  // Dhan writes BAJAJ-AUTO-Oct2026-FUT: drop only the "-Oct2026-…" part, since the underlying
  // itself can contain a hyphen. A plain underlying (from other brokers) is kept whole.
  const raw = String(trade.tradingSymbol ?? '').trim();
  const base = (/^(.+?)-[A-Za-z]{3}\d{4}(?:-|$)/.exec(raw)?.[1] ?? raw).toUpperCase();
  const expiry = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(trade.drvExpiryDate ?? ''));
  if (!base || !expiry) return null;
  const [, year, month, day] = expiry.map(Number);
  const yy = String(year).slice(2);
  const monthly = `${base}${yy}${MONTHS[month - 1]}`;
  if (trade.drvOptionType !== 'CALL' && trade.drvOptionType !== 'PUT') return `${monthly}FUT`;
  const strike = Number(trade.drvStrikePrice);
  if (!(strike > 0)) return null;
  const kind = trade.drvOptionType === 'CALL' ? 'CE' : 'PE';
  // The month's last expiry is the monthly contract; no later expiry fits in the same month. An
  // expiry moved earlier by a holiday counts from its scheduled day (the holidays right after it).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isoDay = (value) =>
    `${year}-${String(month).padStart(2, '0')}-${String(value).padStart(2, '0')}`;
  let scheduled = day;
  while (scheduled < daysInMonth && NSE_HOLIDAYS.has(isoDay(scheduled + 1))) scheduled += 1;
  const prefix =
    scheduled + 7 > daysInMonth
      ? monthly
      : `${base}${yy}${WEEKLY_MONTHS[month - 1]}${String(day).padStart(2, '0')}`;
  return `${prefix}${strike}${kind}`;
}

/** The journal's symbol for a Dhan trade-book or position row (F&O as a Kite-style contract). */
export function journalSymbol(row, exchange) {
  return exchange === 'NFO' || exchange === 'BFO'
    ? contractSymbol(row)
    : String(row.tradingSymbol ?? '')
        .trim()
        .toUpperCase()
        .replace(/-EQ$/, '');
}

/**
 * Quantities held before today, keyed like the fills (exchange:symbol:product):
 * overnight positions (carry-forward buys − sells) and delivery holdings.
 */
export function dhanCarried(positions, holdings) {
  const carried = new Map();
  for (const row of positions) {
    const exchange = EXCHANGES[row.exchangeSegment];
    const symbol = exchange && journalSymbol(row, exchange);
    const overnight = Number(row.carryForwardBuyQty ?? 0) - Number(row.carryForwardSellQty ?? 0);
    if (!symbol || row.productType === 'CNC' || !Number.isInteger(overnight) || !overnight)
      continue;
    const key = `${exchange}:${symbol}:${row.productType}`;
    carried.set(key, (carried.get(key) ?? 0) + overnight);
  }
  for (const holding of holdings) {
    const symbol = journalSymbol(holding, 'NSE');
    const quantity = Number(holding.totalQty ?? 0);
    // A holding can be sold on either exchange.
    if (symbol && Number.isInteger(quantity) && quantity > 0) {
      for (const exchange of ['NSE', 'BSE']) carried.set(`${exchange}:${symbol}:CNC`, quantity);
    }
  }
  return carried;
}

/** Dhan's unzoned timestamps are IST. */
export function istToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(`${value.replace(' ', 'T')}+05:30`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Maps Dhan trade-book rows to the fill shape shared/broker-fills.js pairs. */
export function dhanTradesToFills(trades, tradingDate) {
  const fills = [];
  for (const trade of trades) {
    const filledAt = istToIso(trade.exchangeTime) ?? istToIso(trade.updateTime);
    if (filledAt && brokerTradingDate(Date.parse(filledAt)) !== tradingDate) continue;
    const exchange = EXCHANGES[trade.exchangeSegment] ?? String(trade.exchangeSegment ?? '');
    const symbol = journalSymbol(trade, exchange);
    const quantity = Number(trade.tradedQuantity);
    const price = Number(trade.tradedPrice);
    if (
      !symbol ||
      !['BUY', 'SELL'].includes(trade.transactionType) ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      !(price > 0)
    ) {
      continue;
    }
    fills.push({
      symbol,
      exchange,
      // Intraday and delivery fills of one instrument are separate positions.
      product: String(trade.productType ?? 'CNC'),
      side: trade.transactionType,
      quantity,
      averagePrice: price,
      tradeId: String(trade.exchangeTradeId || trade.orderId || `${symbol}-${fills.length}`),
      orderId: String(trade.orderId ?? ''),
      filledAt,
    });
  }
  return fills;
}

/** Today's Dhan fills in the snapshot shape the fills journal reads. */
export async function readDhanFills(userId) {
  const connection = await loadToken(userId);
  if (!connection) throw new HttpError('Connect your Dhan account in Settings first.', 409);
  const fetchedAt = new Date().toISOString();
  const tradingDate = brokerTradingDate(Date.parse(fetchedAt));
  let payload;
  let positions;
  let holdings;
  try {
    [payload, positions, holdings] = await Promise.all([
      dhanGet('/trades', connection.token),
      dhanGet('/positions', connection.token),
      dhanHoldings(connection.token),
    ]);
  } catch (error) {
    if (error.tokenRejected) {
      // The token was revoked or expired early: mark it unusable, keep the binding.
      await BrokerConnection.updateOne(
        { userId, provider: 'dhan', accessTokenCiphertext: connection.row.accessTokenCiphertext },
        { $set: { expiresAt: new Date(0) } },
      );
    }
    throw error;
  }
  if (!Array.isArray(payload) || payload.length > MAX_TRADES) {
    throw new HttpError('Dhan returned an invalid trade book.', 502);
  }
  return {
    tradingDate,
    fetchedAt,
    trades: dhanTradesToFills(payload, tradingDate),
    carried: dhanCarried(
      Array.isArray(positions) ? positions : [],
      Array.isArray(holdings) ? holdings : [],
    ),
  };
}
