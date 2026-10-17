/**
 * Today page data, state and small formatting helpers.
 */
import { h, icon, pageData } from '../../core/dom.js';
import { toIst } from '../../../../shared/market.js';
import { readResearchArchive, researchCitations } from '../../lib/research-store.js';

export const data = pageData();
export const ownerId = data.accountId;
export const { strategies, rules, settings, portfolioBalance } = data.workspace;
export const aiAvailable = Boolean(data.health?.aiAvailable);
export const allowed = Boolean(ownerId);

const archiveInitial = readResearchArchive(ownerId);
export const state = {
  watchlist: new Set(data.workspace.watchlist.map((item) => item.symbol)),
  archive: archiveInitial,
  storageWarning: !archiveInitial.readable,
  selectedId: archiveInitial.runs[0]?.id ?? '',
  cloudRuns: [],
  cloudError: '',
  cloudLoading: false,
  cloudLoadingMore: false,
  cloudCursor: null,
  analysis: null,
  researchError: '',
  briefing: null,
  briefingLoading: false,
  briefingError: '',
  briefingController: null,
  editingAmount: false,
  savingAmount: false,
  openingAmount: '',
  adding: [],
  addSummary: '',
};

/** Snapshot of today's IST date, strategies, rules and balances sent with a research request. */
export function currentInputs() {
  return {
    businessDate: toIst(new Date()).date,
    strategies: strategies.map(({ id, name, rules: value }) => ({ id, name, rules: value })),
    rules: rules.map(({ id, section, definition, rule }) => ({ id, section, definition, rule })),
    openingBalance: settings.openingBalance,
    journalBalance: portfolioBalance,
    requestedCandidates: 10,
  };
}

/** Formats a timestamp as a medium date and short time in IST. */
export function localTime(value) {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Builds external links for the research sources, or a note when none are usable. */
export function citations(items) {
  const links = researchCitations(items);
  return links.length
    ? h(
        'div',
        { class: 'mt-3 flex flex-wrap gap-2', 'aria-label': 'Research sources' },
        links.map((citation) =>
          h(
            'a',
            {
              href: citation.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              class:
                'focus-ring inline-flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-accent',
            },
            citation.title,
            icon('external-link', 11),
          ),
        ),
      )
    : h(
        'p',
        { class: 'mt-2 text-xs text-muted' },
        'No usable source links returned. Verify the evidence independently.',
      );
}
