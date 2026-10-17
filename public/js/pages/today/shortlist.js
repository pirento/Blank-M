/**
 * Analysis status and today's shortlist of research picks.
 */
import { h, icon, button } from '../../core/dom.js';
import { addSymbols } from './actions.js';
import { allowed, citations, state } from './shared.js';

/** Short status label for the selected research run (or the running analysis). */
export function analysisStatus(selected) {
  return state.analysis
    ? 'Analysing'
    : selected?.outcome === 'completed'
      ? selected.analysis
        ? 'Saved to account'
        : 'Recorded locally'
      : selected?.outcome === 'pending'
        ? 'Outcome unverified'
        : selected?.outcome === 'failed'
          ? 'Request failed'
          : selected?.outcome === 'cancelled'
            ? 'Cancelled'
            : 'Not run';
}

/**
 * Builds the daily shortlist panel for the selected run, with an "Add all to watchlist"
 * button and a note when the run is from an earlier date.
 */
export function shortlist(selected, selectedDate, ist) {
  const picks = selected ? selected.picks : [];
  const section = h(
    'section',
    { class: 'panel research-panel' },
    h(
      'div',
      { class: 'panel-heading' },
      h(
        'h2',
        {},
        'Your daily shortlist ',
        h('span', { class: 'count' }, String(picks.length).padStart(2, '0')),
      ),
      picks.length
        ? button(
            [
              state.adding.length ? 'Saving instruments…' : 'Add all to watchlist',
              icon('plus', 14, 'ml-2'),
            ],
            {
              variant: 'outline',
              disabled: !allowed || state.adding.length > 0,
              onclick: () => void addSymbols(picks.map((pick) => pick.symbol)),
            },
          )
        : null,
    ),
  );
  if (selected && selectedDate !== ist.date)
    section.append(
      h(
        'p',
        { class: 'table-note', role: 'status' },
        `Archived research from ${selectedDate}. This is not today's market view.`,
      ),
    );
  if (picks.length) {
    section.append(
      h(
        'p',
        { class: 'table-note' },
        'Research candidates require your review. ',
        selected?.universe
          ? 'Symbols were checked against the EQ research subset of the official NIFTY 500 index snapshot recorded below.'
          : 'This legacy shortlist has no verified constituent snapshot.',
        ' Prices and market-data freshness remain unverified.',
      ),
      h(
        'div',
        { class: 'tablewrap' },
        h(
          'table',
          { class: 'stock-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Instrument', 'Price', 'Change', 'Research evidence', 'Planning'].map((label) =>
                h('th', {}, label),
              ),
            ),
          ),
          h(
            'tbody',
            {},
            picks.map((stock, index) => {
              const saved = state.watchlist.has(stock.symbol);
              return h(
                'tr',
                {},
                h(
                  'td',
                  {},
                  h(
                    'div',
                    { class: 'symbol-cell' },
                    h('span', { class: 'stock-number' }, String(index + 1).padStart(2, '0')),
                    h(
                      'div',
                      {},
                      h('strong', {}, stock.symbol),
                      h(
                        'small',
                        {},
                        selected?.universe
                          ? 'NIFTY 500 snapshot · EQ research'
                          : 'NSE symbol · legacy unverified universe',
                      ),
                    ),
                  ),
                ),
                h('td', { class: 'numeric' }, '—'),
                h('td', { class: 'numeric' }, '—'),
                h(
                  'td',
                  {},
                  h(
                    'details',
                    {},
                    h(
                      'summary',
                      { class: 'focus-ring cursor-pointer text-sm text-accent' },
                      'Review evidence',
                    ),
                    h('p', { class: 'mt-2 max-w-md text-sm' }, stock.reason),
                    stock.detailedNews
                      ? h('p', { class: 'mt-2 max-w-md text-xs text-muted' }, stock.detailedNews)
                      : null,
                    citations(stock.citations ?? []),
                  ),
                ),
                h(
                  'td',
                  {},
                  h(
                    'div',
                    { class: 'flex flex-wrap gap-2' },
                    button(
                      saved
                        ? [icon('check', 13, 'mr-1'), 'Added']
                        : state.adding.includes(stock.symbol)
                          ? 'Saving…'
                          : [icon('plus', 13, 'mr-1'), 'Watchlist'],
                      {
                        variant: 'outline',
                        size: 'sm',
                        disabled: !allowed || state.adding.length > 0 || saved,
                        onclick: () => void addSymbols([stock.symbol]),
                      },
                    ),
                    h(
                      'a',
                      {
                        class:
                          'focus-ring inline-flex items-center gap-1 rounded-control px-2 text-xs text-accent',
                        href: `/calculator?symbol=${encodeURIComponent(stock.symbol)}`,
                      },
                      'Calculate',
                      icon('arrow-right', 12),
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
      selected ? h('div', { class: 'px-5 pb-5' }, citations(selected.sources)) : null,
    );
  } else {
    section.append(
      h(
        'div',
        { class: 'research-empty' },
        h('span', { class: 'research-glyph' }, icon('calendar', 28)),
        h(
          'div',
          {},
          h('h3', {}, 'A market view starts with evidence.'),
          h(
            'p',
            {},
            selected?.outcome === 'completed'
              ? 'The analysis returned no candidates. No instruments have been invented to fill the shortlist.'
              : 'Run an analysis when your AI service is available. Review its sources before moving a shortlist into your trading plan.',
          ),
          h(
            'a',
            {
              href: '/prototype/index.html',
              class:
                'focus-ring inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-accent px-4 text-sm text-accent-fg',
            },
            'Explore sample shortlist',
            icon('arrow-right', 14),
          ),
        ),
      ),
    );
    if (selected?.sources.length)
      section.append(h('div', { class: 'px-5 pb-5' }, citations(selected.sources)));
  }
  if (state.addSummary)
    section.append(h('p', { role: 'status', class: 'px-5 pb-5 text-sm' }, state.addSummary));
  return section;
}
