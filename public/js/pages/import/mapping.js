/**
 * Column mapping, sheet picker, summary tiles and the row preview.
 */
import {
  h,
  cn,
  button,
  input,
  label,
  select,
  badge,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  emptyState,
  statCard,
  formatCurrency,
  icon,
} from '../../core/dom.js';
import { errorMessage } from '../../core/api.js';
import { notify } from '../../core/toast.js';
import { REQUIRED_FIELDS } from '../../../../shared/csv.js';
import { computeTradeEconomics } from '../../../../shared/pnl.js';
import { paint } from './paint.js';
import { selectSheet } from './reading.js';
import { runImport } from './run.js';
import {
  FIELD_LABELS,
  PREVIEW_ROWS,
  available,
  chargesFor,
  derived,
  reading,
  recoveryError,
  state,
} from './shared.js';

/** What happened when a broker tradebook was paired into round trips. */
function tradebookNotice({ fills, open, skipped }) {
  const openText = open
    .slice(0, 8)
    .map((item) => `${item.symbol} ${item.quantity > 0 ? '+' : ''}${item.quantity} on ${item.date}`)
    .join(', ');
  return h(
    'div',
    {
      role: 'status',
      'data-tradebook': '',
      class: 'space-y-1 rounded-card border border-line bg-accent-soft p-4 text-sm text-fg',
    },
    h(
      'p',
      {},
      h('strong', {}, 'Broker tradebook recognised. '),
      `Read ${fills} equity ${fills === 1 ? 'fill' : 'fills'} and paired them into ${state.rows.length} same-day ${state.rows.length === 1 ? 'round trip' : 'round trips'} below.`,
    ),
    open.length
      ? h(
          'p',
          { class: 'text-xs text-muted' },
          `Not imported, still open at the end of the day (delivery or carried positions): ${openText}${open.length > 8 ? ` and ${open.length - 8} more` : ''}.`,
        )
      : null,
    skipped.length
      ? h(
          'p',
          { class: 'text-xs text-muted' },
          `${skipped.length} ${skipped.length === 1 ? 'row was' : 'rows were'} skipped (F&O or unreadable), first on line ${skipped[0].line}: ${skipped[0].reason}`,
        )
      : null,
  );
}

/**
 * Builds the mapping step: sheet picker, tradebook notice, column selects and import
 * options, then (once required fields are mapped) totals, row errors and a preview table.
 * Controls are locked while a saved import exists or an import is running.
 */
export function mappingSection() {
  const locked = Boolean(state.batch) || state.importing;
  const parts = [];
  if (state.sheets.length > 0) {
    const sheetSelect = select(
      { id: 'workbook-sheet', disabled: locked || state.readingFile },
      state.sheets.map((sheet, index) => ({
        value: String(index),
        label: `${sheet.name} · ${sheet.rows.length} rows`,
        selected: index === state.selectedSheet,
      })),
    );
    sheetSelect.addEventListener('change', () => {
      reading.controller?.abort();
      const controller = new AbortController();
      reading.controller = controller;
      state.readingFile = true;
      paint();
      selectSheet(state.sheets, Number(sheetSelect.value), controller)
        .catch((error) => {
          if (!controller.signal.aborted)
            notify(errorMessage(error, 'Could not select sheet.'), 'error');
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            state.readingFile = false;
            paint();
          }
        });
    });
    parts.push(
      h(
        'div',
        { class: 'max-w-md space-y-2' },
        label('Workbook sheet', 'workbook-sheet'),
        sheetSelect,
        h(
          'p',
          { class: 'text-xs text-muted' },
          'Only the selected sheet is imported. Formula cells use the workbook’s saved values; formulas are never executed.',
        ),
      ),
    );
  }

  const basis = state.mapping?.priceBasis ?? 'entry-exit';
  const basisSelect = h(
    'select',
    {
      id: 'price-basis',
      class:
        'w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-fg h-10 focus-ring',
      disabled: locked,
    },
    h(
      'option',
      { value: 'ambiguous', disabled: true, selected: basis === 'ambiguous' },
      'Choose the price meaning',
    ),
    h(
      'option',
      { value: 'entry-exit', selected: basis === 'entry-exit' },
      'Chronological Entry / Exit',
    ),
    h(
      'option',
      { value: 'buy-sell', selected: basis === 'buy-sell' },
      'Transaction-side Buy / Sell',
    ),
  );
  basisSelect.addEventListener('change', () => {
    if (state.mapping) state.mapping = { ...state.mapping, priceBasis: basisSelect.value };
    paint();
  });
  const reference = input({
    id: 'import-reference',
    disabled: locked,
    value: state.importReference,
    placeholder: 'Leave blank for normal import',
  });
  reference.addEventListener('change', () => {
    state.importReference = reference.value;
    paint();
  });
  reference.addEventListener('input', () => {
    state.importReference = reference.value;
  });

  const fieldControls = Object.keys(FIELD_LABELS).map((field) => {
    const value = state.mapping?.[field] ?? -1;
    const missing = value === -1 && REQUIRED_FIELDS.includes(field);
    const control = select(
      { id: `map-${field}`, disabled: locked, className: missing ? 'border-caution' : '' },
      [
        { value: '-1', label: '— not in this file —', selected: value === -1 },
        ...state.headers.map((header, index) => ({
          value: String(index),
          label: header || `Column ${index + 1}`,
          selected: value === index,
        })),
      ],
    );
    control.addEventListener('change', () => {
      if (state.mapping) state.mapping = { ...state.mapping, [field]: Number(control.value) };
      paint();
    });
    const text =
      state.mapping?.priceBasis === 'buy-sell' && field === 'entryPrice'
        ? 'Buy price'
        : state.mapping?.priceBasis === 'buy-sell' && field === 'exitPrice'
          ? 'Sell price'
          : FIELD_LABELS[field];
    return h('div', { class: 'space-y-2' }, label(text, `map-${field}`), control);
  });

  if (state.tradebook) parts.push(tradebookNotice(state.tradebook));

  parts.push(
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle('Match the columns'),
          h(
            'p',
            { class: 'mt-0.5 text-xs text-muted' },
            `${state.fileName} · ${state.rows.length} ${state.rows.length === 1 ? 'row' : 'rows'}`,
          ),
        ),
      ),
      cardContent(
        'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4',
        h(
          'div',
          { class: 'space-y-2' },
          label('Price columns describe', 'price-basis'),
          basisSelect,
        ),
        h(
          'div',
          { class: 'space-y-2' },
          label('Separate import reference (optional)', 'import-reference'),
          reference,
          h(
            'p',
            { class: 'text-xs text-muted' },
            'Use a new reference only for an intentional additional copy. Reuse it for retries, including on another device.',
          ),
        ),
        fieldControls,
      ),
    ),
  );

  const { candidates, errors, duplicateLines, toImport, missingRequired, netTotal } = derived();
  if (missingRequired.length > 0) {
    parts.push(
      h(
        'p',
        {
          role: 'alert',
          class: 'rounded-card border border-caution bg-caution-soft p-4 text-sm text-fg',
        },
        'Still need a column for ',
        h('strong', {}, missingRequired.map((field) => FIELD_LABELS[field]).join(', ')),
        '. Nothing can be imported until every required field is matched.',
      ),
    );
    return parts;
  }

  parts.push(
    h(
      'div',
      { class: 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4' },
      statCard({
        label: 'Ready to import',
        value: String(toImport.length),
        hint: `of ${state.rows.length} rows in the file`,
      }),
      statCard({
        label: 'Duplicates',
        value: String(duplicateLines.size),
        hint: state.skipDuplicates ? 'Will be skipped' : 'Will be imported anyway',
        tone: duplicateLines.size > 0 ? 'negative' : 'neutral',
      }),
      statCard({
        label: 'Rows with problems',
        value: String(errors.length),
        hint: errors.length > 0 ? 'Listed below, and skipped' : 'None',
        tone: errors.length > 0 ? 'negative' : 'neutral',
      }),
      statCard({
        label: 'Net P&L of the import',
        value: formatCurrency(netTotal),
        hint: 'After charges at your configured rates',
        tone: netTotal >= 0 ? 'positive' : 'negative',
      }),
    ),
  );

  if (errors.length > 0) {
    parts.push(
      card(
        {},
        cardHeader(
          '',
          h(
            'h3',
            { class: 'flex items-center gap-2 text-base font-normal text-fg' },
            icon('triangle-alert', 15, 'text-caution'),
            `${errors.length} ${errors.length === 1 ? 'row' : 'rows'} will be skipped`,
          ),
        ),
        cardContent(
          '',
          h(
            'ul',
            { class: 'max-h-48 space-y-1.5 overflow-y-auto text-sm' },
            errors.map((error) =>
              h(
                'li',
                { class: 'flex gap-3' },
                h('span', { class: 'tnum shrink-0 text-subtle' }, `Line ${error.line}`),
                h('span', { class: 'text-muted' }, error.reason),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const skip =
    duplicateLines.size > 0
      ? h(
          'label',
          { class: 'flex cursor-pointer items-center gap-2 text-sm text-muted' },
          h('input', {
            type: 'checkbox',
            disabled: locked,
            checked: state.skipDuplicates,
            class: 'focus-ring h-4 w-4 rounded border-line-strong accent-[var(--color-accent)]',
            onchange: (event) => {
              state.skipDuplicates = event.target.checked;
              paint();
            },
          }),
          'Skip duplicates',
        )
      : null;
  const th = (text, right = false) =>
    h('th', { class: cn('px-4 py-3', right && 'text-right') }, text);
  parts.push(
    card(
      {},
      cardHeader('', cardTitle('Preview'), skip),
      cardContent(
        'p-0 sm:p-0',
        candidates.length === 0
          ? h(
              'div',
              { class: 'p-6' },
              emptyState({
                title: 'No importable rows',
                hint: 'Every row was rejected. Check the column matching above.',
              }),
            )
          : h(
              'div',
              { class: 'overflow-x-auto' },
              h(
                'table',
                { class: 'w-full min-w-[760px] text-sm' },
                h(
                  'thead',
                  { class: 'border-b border-line text-left text-xs text-muted' },
                  h(
                    'tr',
                    {},
                    th('Date'),
                    th('Symbol'),
                    th('Side'),
                    th('Qty', true),
                    th('Entry', true),
                    th('Exit', true),
                    th('Charges', true),
                    th('Net P&L', true),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  candidates.slice(0, PREVIEW_ROWS).map((candidate) => {
                    const economics = computeTradeEconomics(
                      candidate,
                      chargesFor(candidate.segment),
                    );
                    const isDuplicate = duplicateLines.has(candidate.line);
                    return h(
                      'tr',
                      {
                        class: cn(
                          'border-b border-line last:border-0',
                          isDuplicate && state.skipDuplicates && 'opacity-50',
                        ),
                      },
                      h('td', { class: 'tnum px-4 py-2.5 whitespace-nowrap' }, candidate.date),
                      h(
                        'td',
                        { class: 'px-4 py-2.5 font-medium text-fg' },
                        candidate.symbol,
                        isDuplicate ? badge('Duplicate', 'caution', 'ml-2') : null,
                      ),
                      h(
                        'td',
                        {
                          class: cn(
                            'px-4 py-2.5',
                            candidate.type === 'Long' ? 'text-positive' : 'text-negative',
                          ),
                        },
                        candidate.type,
                      ),
                      h('td', { class: 'tnum px-4 py-2.5 text-right' }, String(candidate.quantity)),
                      h(
                        'td',
                        { class: 'tnum px-4 py-2.5 text-right' },
                        String(candidate.entryPrice),
                      ),
                      h(
                        'td',
                        { class: 'tnum px-4 py-2.5 text-right' },
                        String(candidate.exitPrice),
                      ),
                      h(
                        'td',
                        { class: 'tnum px-4 py-2.5 text-right text-muted' },
                        formatCurrency(economics.charges),
                      ),
                      h(
                        'td',
                        {
                          class: cn(
                            'tnum px-4 py-2.5 text-right font-medium',
                            economics.netPnl >= 0 ? 'text-positive' : 'text-negative',
                          ),
                        },
                        formatCurrency(economics.netPnl),
                      ),
                    );
                  }),
                ),
              ),
              candidates.length > PREVIEW_ROWS
                ? h(
                    'p',
                    { class: 'border-t border-line px-4 py-3 text-xs text-muted' },
                    `Showing the first ${PREVIEW_ROWS} of ${candidates.length} rows. All of them will be imported.`,
                  )
                : null,
            ),
      ),
    ),
  );

  parts.push(
    h(
      'div',
      { class: 'flex flex-wrap items-center justify-between gap-3' },
      h(
        'p',
        { class: 'text-sm text-muted' },
        state.importing
          ? `Importing ${state.progress} of ${toImport.length}…`
          : state.batch
            ? 'A saved import is in progress. Use Retry saved import above.'
            : 'Nothing is saved until you press import.',
      ),
      button(
        state.importing
          ? 'Importing…'
          : `Import ${toImport.length} ${toImport.length === 1 ? 'trade' : 'trades'}`,
        {
          size: 'lg',
          disabled:
            state.importing ||
            state.readingFile ||
            !available ||
            Boolean(state.batch) ||
            Boolean(recoveryError) ||
            toImport.length === 0,
          onclick: () => void runImport(),
        },
      ),
    ),
  );
  return parts;
}
