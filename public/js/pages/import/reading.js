/**
 * Reading the chosen file: CSV text or an Excel workbook sheet, then resetting
 * the page for another file.
 */
import { api, errorMessage } from '../../core/api.js';
import { notify } from '../../core/toast.js';
import { guessMapping, parseCsv } from '../../../../shared/csv.js';
import { detectTradebook, tradebookToRoundTrips } from '../../../../shared/tradebook.js';
import { hashImportSource } from '../../lib/import-ledger.js';
import { paint } from './paint.js';
import { MAX_FILE_BYTES, fileInput, reading, state } from './shared.js';

/**
 * Headers and rows to map. A broker tradebook (one row per fill) is first
 * paired into round trips; `tradebook` then summarises the conversion.
 */
function prepareRows(headers, rows) {
  if (!detectTradebook(headers)) return { headers, rows, tradebook: null };
  const converted = tradebookToRoundTrips(headers, rows);
  return {
    headers: converted.headers,
    rows: converted.rows,
    tradebook: { fills: converted.fills, open: converted.open, skipped: converted.skipped },
  };
}

/**
 * Loads one workbook sheet into `state`: hashes it for the import digest, pairs tradebook
 * fills into round trips and guesses the column mapping. Throws when the sheet has no header.
 */
export async function selectSheet(sheets, index, controller) {
  const parsed = sheets[index];
  if (!parsed?.headers.length) throw new Error('That sheet has no header row.');
  const digest = await hashImportSource(JSON.stringify(parsed));
  if (controller.signal.aborted) return;
  const prepared = prepareRows(parsed.headers, parsed.rows);
  Object.assign(state, {
    selectedSheet: index,
    sourceDigest: digest,
    ...prepared,
    mapping: guessMapping(prepared.headers),
    stage: 'map',
  });
}

async function readWorkbook(file, signal) {
  const form = new FormData();
  form.append('file', file);
  const result = await api('/api/import/workbook', {
    method: 'POST',
    form,
    signal,
    timeout: 60_000,
  });
  return result.sheets;
}

/**
 * Reads a chosen CSV or .xlsx file (max 5 MB) into `state` and moves to the mapping step.
 * Aborts any earlier read; errors are shown as a toast.
 */
export async function readFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    notify('That file is larger than 5 MB. Split the export and import it in parts.', 'error');
    return;
  }
  reading.controller?.abort();
  const controller = new AbortController();
  reading.controller = controller;
  state.readingFile = true;
  paint();
  try {
    if (/\.xls$/i.test(file.name))
      throw new Error('Save this older .xls file as .xlsx or CSV first.');
    if (/\.xlsx$/i.test(file.name)) {
      const sheets = await readWorkbook(file, controller.signal);
      if (controller.signal.aborted) return;
      state.sheets = sheets;
      state.fileName = file.name;
      const first = sheets.findIndex((sheet) => sheet.headers.length > 0);
      if (first < 0) throw new Error('The workbook has no nonempty sheets.');
      await selectSheet(sheets, first, controller);
    } else {
      if (!/\.csv$/i.test(file.name)) throw new Error('Choose a CSV or Excel .xlsx file.');
      const contents = await file.text();
      const parsed = parseCsv(contents);
      const digest = await hashImportSource(contents);
      if (controller.signal.aborted) return;
      if (parsed.headers.length === 0)
        throw new Error('That file has no header row, so there is nothing to map.');
      const prepared = prepareRows(parsed.headers, parsed.rows);
      Object.assign(state, {
        sheets: [],
        sourceDigest: digest,
        fileName: file.name,
        ...prepared,
        mapping: guessMapping(prepared.headers),
        stage: 'map',
      });
    }
  } catch (error) {
    if (!controller.signal.aborted)
      notify(errorMessage(error, 'Could not read that file.'), 'error');
  } finally {
    if (!controller.signal.aborted) {
      state.readingFile = false;
      paint();
    }
  }
}

/** Cancels any file read and returns the page to the file chooser with all file state cleared. */
export function reset() {
  reading.controller?.abort();
  Object.assign(state, {
    readingFile: false,
    sheets: [],
    stage: 'choose',
    fileName: '',
    sourceDigest: '',
    importReference: '',
    headers: [],
    rows: [],
    tradebook: null,
    mapping: null,
    progress: 0,
  });
  fileInput.value = '';
  paint();
}
