/**
 * Research history list (this browser and cloud).
 */
import { h, button, card, cardHeader, cardTitle, cardContent, select } from '../../core/dom.js';
import { localCompletionSupersedesPending } from '../../lib/research-store.js';
import { runAnalysis } from './actions.js';
import { loadOlderResearch, refreshCloud } from './archive.js';
import { paint } from './cards.js';
import { allowed, currentInputs, localTime, state } from './shared.js';

/**
 * Builds the research history card: refresh/load-older buttons, a picker over cloud and
 * browser-only runs (newest first), and details of the selected run with a retry option.
 */
export function history(selected, selectedLocal, selectedCloud, selectedDate) {
  const choices = [
    ...state.cloudRuns.map((run) => ({
      id: run.requestId,
      startedAt: run.startedAt,
      outcome: localCompletionSupersedesPending(
        state.archive.runs.find((local) => local.id === run.requestId),
        run,
      )
        ? 'completed'
        : run.outcome,
    })),
    ...state.archive.runs.filter(
      (run) => !state.cloudRuns.some((cloud) => cloud.requestId === run.id),
    ),
  ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const content = cardContent(
    'space-y-3',
    h(
      'p',
      { class: 'text-xs leading-5 text-muted' },
      'Every Run analysis creates a new saved analysis; there is no daily or session cap. Successful account saves are available across devices. The latest 20 browser entries are a local fallback, not confirmed cloud saves. Rule and strategy inputs are captured snapshots, not approved versions. New analyses require an official verified NIFTY 500 constituent snapshot. The complete index list is retained; only EQ-series securities are eligible for this research workflow. Index membership does not approve a trade.',
    ),
    button(state.cloudLoading ? 'Loading saved research…' : 'Refresh saved research', {
      variant: 'outline',
      disabled: !allowed || state.cloudLoading,
      onclick: () => void refreshCloud(),
    }),
    state.cloudCursor
      ? button(state.cloudLoadingMore ? 'Loading older research…' : 'Load older research', {
          variant: 'outline',
          className: 'ml-2',
          disabled: !allowed || state.cloudLoading || state.cloudLoadingMore,
          onclick: () => void loadOlderResearch(),
        })
      : null,
    state.cloudError
      ? h('p', { role: 'status', class: 'text-xs text-caution' }, state.cloudError)
      : null,
    state.storageWarning
      ? h(
          'p',
          { role: 'alert', class: 'text-sm text-caution' },
          'Browser storage could not be read or updated. This page keeps current results only until you leave; existing unreadable data has been preserved.',
        )
      : null,
  );
  if (!choices.length) {
    content.append(
      h('p', { class: 'text-sm text-muted' }, 'No research requests saved in this browser.'),
    );
  } else {
    const picker = select(
      { id: 'research-history', disabled: Boolean(state.analysis) },
      choices.map((run) => ({
        value: run.id,
        selected: run.id === state.selectedId,
        label: `${localTime(run.startedAt)} IST · ${run.outcome === 'pending' ? 'Outcome unverified' : run.outcome}`,
      })),
    );
    picker.addEventListener('change', () => {
      state.selectedId = picker.value;
      state.researchError = '';
      paint();
    });
    content.append(
      h('label', { for: 'research-history', class: 'text-sm font-medium' }, 'Recorded request'),
      picker,
    );
    if (selected) {
      const u = selected.universe;
      const eligible = u ? (u.eligibleConstituentCount ?? u.constituentCount) : 0;
      const canRetry =
        selectedLocal &&
        !selectedLocal.analysis &&
        selectedLocal.outcome !== 'completed' &&
        !state.analysis &&
        JSON.stringify(selectedLocal.inputs) === JSON.stringify(currentInputs());
      content.append(
        h(
          'div',
          { class: 'space-y-2 text-xs text-muted' },
          h(
            'p',
            {},
            `Request ${selected.id} · Started ${localTime(selected.startedAt)} IST${selected.finishedAt ? ` · Finished ${localTime(selected.finishedAt)} IST` : ' · No final outcome recorded'}`,
          ),
          h(
            'p',
            {},
            `${selected.analysis ? 'Saved to your account.' : 'Browser-only record; cloud persistence is not confirmed.'} Captured inputs from ${selectedDate}. Market-data timestamps and freshness are unverified.`,
          ),
          u
            ? h(
                'p',
                { class: 'break-words' },
                `NIFTY 500 · ${u.constituentCount} published constituents · ${eligible} EQ research eligible · ${u.constituentCount - eligible} other-series excluded · fetched ${localTime(u.fetchedAt)} IST · snapshot expiry ${localTime(u.expiresAt)} IST · ${u.version}. `,
                h(
                  'a',
                  {
                    class: 'focus-ring text-accent',
                    href: u.sourceUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  },
                  'Official constituent source',
                ),
              )
            : null,
          canRetry
            ? button('Retry same request', {
                variant: 'outline',
                disabled: !allowed,
                onclick: () => void runAnalysis(selectedLocal),
              })
            : null,
          h(
            'details',
            {},
            h('summary', { class: 'focus-ring cursor-pointer' }, 'Review captured inputs'),
            h(
              'pre',
              {
                class:
                  'mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control bg-elevated p-3',
              },
              JSON.stringify(selectedCloud?.inputs ?? selectedLocal?.inputs, null, 2),
            ),
          ),
        ),
      );
    }
  }
  return card({}, cardHeader('', cardTitle('Research history')), content);
}
