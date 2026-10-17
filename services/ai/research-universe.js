/**
 * The NIFTY 500 research universe: downloads and verifies the official
 * constituent list and caches it for a few hours.
 */
import { createHash } from 'node:crypto';

import { NSE_SYMBOL_RE } from '../../shared/ai-schemas.js';

export const NIFTY500_SOURCE_URL =
  'https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv';
export const RESEARCH_UNIVERSE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CSV_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Stable content identity shared by the official loader and saved-snapshot verification. */
export function researchUniverseVersion(constituents) {
  const canonical = constituents
    .map(({ name, industry, symbol, series, isin }) => ({ name, industry, symbol, series, isin }))
    .sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0));
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}
export class ResearchUniverseError extends Error {
  status = 503;
  constructor(
    message = 'The official NIFTY 500 constituent list could not be verified. Analysis has not started; try again later.',
  ) {
    super(message);
    this.name = 'ResearchUniverseError';
  }
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const pushField = () => {
    row.push(field.trim());
    field = '';
    closedQuote = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value !== '')) rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else field += character;
    } else if (character === ',') pushField();
    else if (character === '\n' || character === '\r') {
      pushRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else if (closedQuote) {
      if (character !== ' ' && character !== '\t') throw new ResearchUniverseError();
    } else if (character === '"') {
      if (field.trim()) throw new ResearchUniverseError();
      field = '';
      quoted = true;
    } else field += character;
  }
  if (quoted) throw new ResearchUniverseError();
  if (field || row.length || closedQuote) pushRow();
  return rows;
}

/**
 * Parses and validates the official NIFTY 500 constituent CSV into a symbol-sorted snapshot with
 * metadata (source, fetch/expiry times, content version, counts) and the symbol sets. Throws
 * ResearchUniverseError for oversized, malformed, duplicated or out-of-range lists, or one with no
 * EQ symbols.
 */
export function parseNifty500Csv(csv, fetchedAt = new Date()) {
  if (
    Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES ||
    csv.includes('\0') ||
    !Number.isFinite(fetchedAt.getTime())
  )
    throw new ResearchUniverseError();
  const rows = csvRows(csv.replace(/^\uFEFF/, ''));
  const headers = rows.shift()?.map((header) => header.toLowerCase()) ?? [];
  const required = ['company name', 'industry', 'symbol', 'series', 'isin code'];
  if (new Set(headers).size !== headers.length || required.some((name) => !headers.includes(name)))
    throw new ResearchUniverseError();
  const symbols = new Set();
  const isins = new Set();
  const constituents = rows.map((row) => {
    if (row.length !== headers.length) throw new ResearchUniverseError();
    const get = (header) => row[headers.indexOf(header)] ?? '';
    const constituent = {
      name: get('company name'),
      industry: get('industry'),
      symbol: get('symbol'),
      series: get('series'),
      isin: get('isin code'),
    };
    if (
      !constituent.name ||
      constituent.name.length > 300 ||
      !constituent.industry ||
      constituent.industry.length > 300 ||
      !NSE_SYMBOL_RE.test(constituent.symbol) ||
      !/^[A-Z]{1,4}$/.test(constituent.series) ||
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(constituent.isin) ||
      symbols.has(constituent.symbol) ||
      isins.has(constituent.isin)
    )
      throw new ResearchUniverseError();
    symbols.add(constituent.symbol);
    isins.add(constituent.isin);
    return constituent;
  });
  if (constituents.length < 400 || constituents.length > 600)
    throw new ResearchUniverseError(
      'The official constituent file is outside the supported 400–600 row anomaly guard. Analysis is paused until the published list is reviewed.',
    );
  const eligibleSymbols = new Set(
    constituents.filter((item) => item.series === 'EQ').map((item) => item.symbol),
  );
  if (!eligibleSymbols.size)
    throw new ResearchUniverseError(
      'The official constituent list contains no supported EQ research candidates. Analysis has not started.',
    );
  constituents.sort((left, right) =>
    left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0,
  );
  const version = researchUniverseVersion(constituents);
  return {
    metadata: {
      name: 'NIFTY 500',
      sourceUrl: NIFTY500_SOURCE_URL,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + RESEARCH_UNIVERSE_TTL_MS).toISOString(),
      version,
      constituentCount: constituents.length,
      eligibleConstituentCount: eligibleSymbols.size,
    },
    constituents,
    symbols,
    eligibleSymbols,
  };
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  let cancel = () => undefined;
  const interrupted = new Promise((_resolve, reject) => {
    cancel = () => reject(new ResearchUniverseError());
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
async function readCsv(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_CSV_BYTES))
    throw new ResearchUniverseError();
  if (!response.body) throw new ResearchUniverseError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_CSV_BYTES) throw new ResearchUniverseError();
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    // Cleanup must not extend the source deadline when a transport stalls cancellation.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Normal configured fetch/proxy/CA trust only. No alternate host or stale-list fallback. */
export function createResearchUniverseLoader(options = {}) {
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let cached = null;
  let inFlight = null;
  return async function load() {
    const time = now();
    if (
      cached &&
      time.getTime() >= Date.parse(cached.metadata.fetchedAt) &&
      time.getTime() < Date.parse(cached.metadata.expiresAt)
    )
      return cached;
    if (inFlight) return inFlight;
    // Install the flight before invoking fetch: synchronous transport failures
    // must not leave a rejected promise cached after its finally block runs.
    inFlight = Promise.resolve().then(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await abortable(
          request(NIFTY500_SOURCE_URL, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { Accept: 'text/csv' },
          }),
          controller.signal,
        );
        if (
          !response.ok ||
          response.redirected ||
          (response.url && response.url !== NIFTY500_SOURCE_URL)
        )
          throw new ResearchUniverseError();
        const result = parseNifty500Csv(await readCsv(response, controller.signal), now());
        controller.signal.throwIfAborted();
        cached = result;
        return result;
      } catch (error) {
        cached = null;
        throw error instanceof ResearchUniverseError ? error : new ResearchUniverseError();
      } finally {
        clearTimeout(timer);
        inFlight = null;
      }
    });
    return inFlight;
  };
}
export const loadResearchUniverse = createResearchUniverseLoader();
