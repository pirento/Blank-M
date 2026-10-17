/**
 * The saved-batch card and the choose-a-file card.
 */
import { h, cn, button, card, cardContent, icon } from '../../core/dom.js';
import { importCounts } from '../../lib/import-ledger.js';
import { paint } from './paint.js';
import { readFile } from './reading.js';
import { openCloseBatch, runImport } from './run.js';
import { available, fileInput, state } from './shared.js';

/** Builds the saved-import card: per-row outcome counts, recovery notes, and Close / Retry buttons. */
export function batchCard() {
  const counts = importCounts(state.batch);
  return card(
    {},
    cardContent(
      'space-y-3',
      h('p', { class: 'text-sm font-medium' }, `Saved import: ${state.batch.fileName}`),
      h(
        'p',
        { class: 'text-sm text-muted' },
        `${counts.acknowledged} of ${counts.total} acknowledged and kept · ${counts.failed} failed · ${counts.unknown} unknown · ${counts.pending} not attempted`,
      ),
      h(
        'p',
        { class: 'text-xs text-muted' },
        'Retries keep the original row IDs and charge calculations. Recovery works in this tab after reload, for this account. After storage loss or on another device, select the same CSV content or selected workbook sheet, column mapping and import reference to recover the same row IDs. Different reconstructed values stop safely.',
      ),
      h(
        'p',
        { class: 'text-xs text-muted' },
        `Import reference: ${state.batch.reference || 'Default operation'}`,
      ),
      h(
        'div',
        { class: 'flex flex-wrap gap-2' },
        button('Close saved import', {
          variant: 'outline',
          disabled: state.importing,
          onclick: openCloseBatch,
        }),
        button(state.importing ? 'Importing…' : 'Retry saved import', {
          disabled: state.importing || !available,
          onclick: () => void runImport(),
        }),
      ),
    ),
  );
}

/** Builds the file drop zone and "Choose a file" button; a dropped file is read via `readFile()`. */
export function chooseCard() {
  const zone = h(
    'div',
    {
      class: cn(
        'flex flex-col items-center justify-center rounded-card border border-dashed px-6 py-16 text-center transition-colors',
        state.dragging ? 'border-accent bg-accent-soft' : 'border-line',
      ),
      ondragover: (event) => {
        event.preventDefault();
        if (!state.dragging) {
          state.dragging = true;
          paint();
        }
      },
      ondragleave: () => {
        state.dragging = false;
        paint();
      },
      ondrop: (event) => {
        event.preventDefault();
        state.dragging = false;
        const file = event.dataTransfer.files[0];
        if (file) void readFile(file);
        else paint();
      },
    },
    h('div', { class: 'mb-4 text-subtle' }, icon('file-up', 28)),
    h('p', { class: 'text-sm font-medium text-fg' }, 'Drop a CSV or Excel .xlsx here'),
    h(
      'p',
      { class: 'mt-1 max-w-sm text-sm text-muted' },
      'Exports from Zerodha and other common Indian brokers are recognised automatically. Map the columns and choose the workbook sheet on the next screen. Older .xls files must first be saved as .xlsx or CSV.',
    ),
    button([icon('upload', 14, 'mr-2'), state.readingFile ? 'Reading file…' : 'Choose a file'], {
      className: 'mt-6',
      disabled: state.readingFile,
      onclick: () => fileInput.click(),
    }),
  );
  return card(
    {},
    cardContent(
      '',
      zone,
      h(
        'div',
        { class: 'mt-6 rounded-card border border-line bg-elevated p-4' },
        h('p', { class: 'text-sm font-medium text-fg' }, 'What the file needs'),
        h(
          'p',
          { class: 'mt-1.5 text-sm leading-relaxed text-muted' },
          'One row per completed round trip, with a date, symbol, buy/sell, entry price, exit price and quantity. Paired Buy/Sell price columns follow the direction; Entry/Exit columns stay chronological. Charges are calculated here from your configured rates, so a brokerage column is not needed and will be ignored. Dates written as numbers are read day-first — ',
          h('span', { class: 'tnum' }, '03/04/2026'),
          ' is 3 April.',
        ),
      ),
    ),
  );
}
