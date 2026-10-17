/**
 * Zerodha instrument master (NSE equities): parse the public CSV and refresh
 * the stored list when it is stale.
 */
import { Instrument } from '../../models/index.js';
import { isDatabaseConnected } from '../../config/database.js';
import { MarketDataError } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('kite');

const INSTRUMENT_URL = process.env.KITE_INSTRUMENTS_URL || 'https://api.kite.trade/instruments/NSE';
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 500;
const MIN_INTERVAL_MS = 60 * 60_000;
let lastAttemptAt = 0;
let inFlight = null;

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else value += character;
  }
  cells.push(value);
  return cells;
}

function numeric(value) {
  const found = Number(value);
  return Number.isFinite(found) ? found : null;
}

/**
 * NSE equity rows (exchange NSE, type EQ) from Zerodha's instrument CSV, in the stored row shape;
 * other rows are skipped.
 */
export function parseInstruments(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((value) => value.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const record = Object.fromEntries(
      headers.map((header, index) => [header, values[index] || '']),
    );
    const token = numeric(record.instrument_token);
    const symbol = record.tradingsymbol?.trim().toUpperCase();
    if (token === null || !symbol || record.exchange !== 'NSE' || record.instrument_type !== 'EQ') {
      continue;
    }
    rows.push({
      instrument_key: String(token),
      instrument_token: token,
      exchange_token: numeric(record.exchange_token),
      exchange: 'NSE',
      segment: record.segment || null,
      trading_symbol: symbol,
      name: record.name || null,
      isin: null,
      instrument_type: record.instrument_type || null,
      expiry: record.expiry || null,
      strike: numeric(record.strike),
      lot_size: numeric(record.lot_size),
      tick_size: numeric(record.tick_size),
    });
  }
  return rows;
}

async function download() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(INSTRUMENT_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/csv', 'X-Kite-Version': '3' },
    });
    if (!response.ok)
      throw new MarketDataError(`Instrument master returned ${response.status}`, 502);
    return await response.text();
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MarketDataError('Instrument master download timed out', 504);
    }
    throw new MarketDataError('Could not download the Zerodha instrument master', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads the instrument master and upserts every NSE equity in batches of 500. Returns the row
 * count. Concurrent calls share one run; throws MarketDataError when the database is down or
 * download/storage fails.
 */
export async function refreshInstruments() {
  if (!isDatabaseConnected()) {
    throw new MarketDataError('The database is required to load instruments.', 503);
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    lastAttemptAt = Date.now();
    const rows = parseInstruments(await download());
    if (!rows.length)
      throw new MarketDataError('The instrument master contained no NSE equities.', 502);
    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      try {
        await Instrument.bulkWrite(
          rows.slice(index, index + BATCH_SIZE).map((row) => ({
            updateOne: {
              filter: { _id: row.instrument_key },
              update: {
                $set: {
                  instrumentToken: row.instrument_token,
                  exchangeToken: row.exchange_token,
                  exchange: row.exchange,
                  segment: row.segment,
                  tradingSymbol: row.trading_symbol,
                  name: row.name,
                  isin: row.isin,
                  instrumentType: row.instrument_type,
                  expiry: row.expiry,
                  strike: row.strike,
                  lotSize: row.lot_size,
                  tickSize: row.tick_size,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      } catch {
        throw new MarketDataError('Could not store instruments.', 500);
      }
    }
    return rows.length;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Refreshes the instrument master at most once an hour per process, logging (not throwing)
 * failures. Does nothing while the database is disconnected.
 */
export async function refreshInstrumentsIfStale() {
  if (!isDatabaseConnected() || Date.now() - lastAttemptAt < MIN_INTERVAL_MS) return;
  try {
    log.info('instrument master loaded', { instruments: await refreshInstruments() });
  } catch (error) {
    log.warn('instrument refresh failed; using Yahoo fallback', { reason: error?.message });
  }
}

/**
 * Estimated number of stored instruments; 0 when the database is unavailable or the count fails.
 */
export async function instrumentCount() {
  if (!isDatabaseConnected()) return 0;
  try {
    return await Instrument.estimatedDocumentCount();
  } catch {
    return 0;
  }
}
