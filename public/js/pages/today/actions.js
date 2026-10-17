/**
 * User actions: run the research analysis, prepare the briefing, add picks to
 * the watchlist and update capital.
 */
import { api } from '../../core/api.js';
import { notify, notifyError } from '../../core/toast.js';
import { requestBriefing, requestPicksWithSources } from '../../lib/ai.js';
import { refreshCloud, store } from './archive.js';
import { paint } from './cards.js';
import { allowed, currentInputs, ownerId, settings, state } from './shared.js';

/**
 * Runs (or retries) the AI stock pickup: records a pending run in the archive, requests up
 * to 10 picks with sources, then stores the outcome (completed, failed or cancelled).
 */
export async function runAnalysis(retry) {
  if (!allowed || state.analysis) return;
  const run = retry
    ? { ...retry, outcome: 'pending', finishedAt: null }
    : {
        id: crypto.randomUUID(),
        ownerId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: 'pending',
        inputs: currentInputs(),
        picks: [],
        sources: [],
      };
  const controller = new AbortController();
  const operation = { controller, run };
  state.analysis = operation;
  controller.signal.addEventListener(
    'abort',
    () => {
      if (state.analysis !== operation) return;
      state.analysis = null;
      store({ ...run, finishedAt: new Date().toISOString(), outcome: 'cancelled' });
      state.researchError =
        'Analysis cancelled. The provider may have already processed the request.';
      paint();
    },
    { once: true },
  );
  state.researchError = '';
  state.selectedId = run.id;
  store(run);
  paint();
  try {
    const result = await requestPicksWithSources(
      {
        requestId: run.id,
        strategies: run.inputs.strategies.map((s) => `${s.name}: ${s.rules}`).join('\n'),
        rules: run.inputs.rules.map((r) => `${r.section} — ${r.rule}`).join('\n'),
        count: 10,
      },
      controller.signal,
    );
    if (state.analysis !== operation || controller.signal.aborted) return;
    const unique = new Map(result.picks.map((pick) => [pick.symbol, pick]));
    store({
      ...run,
      finishedAt: new Date().toISOString(),
      outcome: 'completed',
      picks: [...unique.values()].slice(0, 10),
      sources: result.sources,
      universe: result.universe,
      analysis: result.analysis,
    });
    void refreshCloud();
  } catch (requestError) {
    if (state.analysis !== operation) return;
    store({
      ...run,
      finishedAt: new Date().toISOString(),
      outcome: controller.signal.aborted ? 'cancelled' : 'failed',
    });
    state.researchError = controller.signal.aborted
      ? 'Analysis cancelled. The provider may have already processed the request.'
      : requestError instanceof Error
        ? requestError.message
        : 'Could not analyse the market.';
  } finally {
    if (state.analysis === operation) state.analysis = null;
    paint();
  }
}

/** Requests the AI market briefing for today's strategies and rules and stores it in `state`. */
export async function prepareBriefing() {
  if (!allowed || state.briefingController) return;
  const controller = new AbortController();
  state.briefingController = controller;
  const inputs = currentInputs();
  state.briefingLoading = true;
  state.briefingError = '';
  paint();
  try {
    state.briefing = await requestBriefing(
      {
        date: inputs.businessDate,
        strategies: inputs.strategies.map((s) => `${s.name}: ${s.rules}`).join('\n'),
        rules: inputs.rules.map((r) => `${r.section}: ${r.rule}`).join('\n'),
      },
      controller.signal,
    );
  } catch (requestError) {
    if (!controller.signal.aborted)
      state.briefingError =
        requestError instanceof Error
          ? requestError.message
          : 'Could not prepare the market briefing.';
  } finally {
    state.briefingController = null;
    state.briefingLoading = false;
    paint();
  }
}

/** Adds the symbols not already saved to the watchlist one at a time, then shows a count summary. */
export async function addSymbols(symbols) {
  if (state.adding.length) return;
  const unique = [...new Set(symbols)];
  const queue = unique.filter((symbol) => !state.watchlist.has(symbol));
  const already = unique.length - queue.length;
  state.adding = queue;
  state.addSummary = '';
  paint();
  let added = 0;
  let failed = 0;
  for (const symbol of queue) {
    try {
      await api('/api/watchlist', { method: 'POST', body: { symbol } });
      added += 1;
      state.watchlist.add(symbol);
    } catch {
      failed += 1;
    }
    paint();
  }
  state.adding = [];
  state.addSummary = `${added} added · ${already} already saved · ${failed} failed.${failed ? ' Retry to save the remaining instruments.' : ''}`;
  paint();
}

/** Form handler: validates and saves the opening balance via PUT /api/settings. */
export async function updateCapital(event) {
  event.preventDefault();
  if (state.savingAmount) return;
  const value = Number(state.openingAmount);
  if (!state.openingAmount.trim() || !Number.isFinite(value) || value < 0) {
    notify('Enter a valid opening amount.', 'error');
    return;
  }
  state.savingAmount = true;
  paint();
  try {
    await api('/api/settings', { method: 'PUT', body: { openingBalance: value } });
    settings.openingBalance = value;
    state.editingAmount = false;
    state.openingAmount = '';
    notify('Opening balance updated. Reload to refresh the journal balance.', 'success');
  } catch (error) {
    notifyError(error, 'Could not update the opening balance.');
  } finally {
    state.savingAmount = false;
    paint();
  }
}
