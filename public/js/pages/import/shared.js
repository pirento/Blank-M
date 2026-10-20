/**
 * Import page data and state, including recovery of a saved import checkpoint,
 * and the derived preview (candidates, duplicates, problems).
 */
import { $, pageData } from '../../core/dom.js';
import { REQUIRED_FIELDS, buildCandidates, findDuplicateLines } from '../../../../shared/csv.js';
import { computeTradeEconomics } from '../../../../shared/pnl.js';
import { chargesForSegment } from '../../../../shared/segments.js';
import { readImportBatch } from '../../lib/import-ledger.js';

export const FIELD_LABELS = {
  date: 'Date',
  symbol: 'Symbol',
  type: 'Buy / sell',
  entryPrice: 'Entry price',
  exitPrice: 'Exit price',
  quantity: 'Quantity',
  notes: 'Notes (optional)',
};
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const PREVIEW_ROWS = 50;

export const data = pageData();
export const accountId = data.accountId;
const workspace = data.workspace;
export const available = Boolean(accountId && workspace);
export const trades = workspace?.trades ?? [];
/** Charge rates for a row's segment (equity, futures or options), as in the trade form. */
export const chargesFor = (segment) => chargesForSegment(workspace?.settings ?? {}, segment);

export let recoveryError = null;
let initialBatch = null;
try {
  initialBatch = accountId ? readImportBatch(accountId) : null;
} catch {
  recoveryError =
    'The saved import checkpoint could not be read. Keep this tab open and resolve browser storage before importing.';
}

export const state = {
  stage: 'choose',
  fileName: '',
  sheets: [],
  selectedSheet: 0,
  readingFile: false,
  sourceDigest: '',
  importReference: '',
  headers: [],
  rows: [],
  // Set when the file was a broker tradebook converted to round trips.
  tradebook: null,
  mapping: null,
  skipDuplicates: true,
  importing: false,
  progress: 0,
  dragging: false,
  batch: initialBatch,
  importError: recoveryError,
};
// The in-flight file read; starting another read aborts it.
export const reading = { controller: null };

export const fileInput = $('[data-file-input]');

/**
 * Builds trade candidates from the mapped rows and returns them with row errors, duplicate
 * lines, the rows to import, unmapped required fields and the net P&L after charges.
 */
export function derived() {
  const { candidates, errors } = state.mapping
    ? buildCandidates(state.rows, state.mapping)
    : { candidates: [], errors: [] };
  const duplicateLines = findDuplicateLines(candidates, trades);
  const toImport = state.skipDuplicates
    ? candidates.filter((candidate) => !duplicateLines.has(candidate.line))
    : candidates;
  const missingRequired = state.mapping
    ? REQUIRED_FIELDS.filter((field) => state.mapping[field] === -1)
    : REQUIRED_FIELDS;
  const netTotal = toImport.reduce(
    (sum, candidate) =>
      sum + computeTradeEconomics(candidate, chargesFor(candidate.segment)).netPnl,
    0,
  );
  return { candidates, errors, duplicateLines, toImport, missingRequired, netTotal };
}
