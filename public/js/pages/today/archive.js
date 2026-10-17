/**
 * Saved research runs: local archive, the selected run and loading cloud
 * history (newest first, with paging).
 */
import { requestResearchHistory } from '../../lib/ai.js';
import { toIst } from '../../../../shared/market.js';
import { localCompletionSupersedesPending, saveResearchRun } from '../../lib/research-store.js';
import { paint } from './cards.js';
import { allowed, ownerId, state } from './shared.js';

/**
 * Saves a research run in browser storage and puts it first in the local archive (max 20).
 * Sets a storage warning when the save failed.
 */
export function store(run) {
  const saved = saveResearchRun(ownerId, run);
  state.storageWarning = !saved;
  state.archive = {
    readable: saved,
    runs: [run, ...state.archive.runs.filter((item) => item.id !== run.id)].slice(0, 20),
  };
}

/**
 * Resolves the selected research run, preferring the cloud copy unless a newer local
 * completion supersedes it, and returns it with both copies and its IST date.
 */
export function selection() {
  const selectedLocal = state.archive.runs.find((run) => run.id === state.selectedId);
  const selectedCloud = state.cloudRuns.find((run) => run.requestId === state.selectedId);
  const selected =
    selectedCloud && !localCompletionSupersedesPending(selectedLocal, selectedCloud)
      ? {
          ...selectedCloud,
          id: selectedCloud.requestId,
          universe: selectedCloud.universe.metadata,
          analysis: {
            id: selectedCloud.id,
            requestId: selectedCloud.requestId,
            startedAt: selectedCloud.startedAt,
            finishedAt: selectedCloud.finishedAt,
          },
        }
      : selectedLocal;
  const selectedDate = selectedCloud
    ? toIst(new Date(selectedCloud.startedAt)).date
    : selectedLocal?.inputs.businessDate;
  return { selected, selectedLocal, selectedCloud, selectedDate };
}

let cloudController = null;
/**
 * Reloads the first page of cloud research history, keeping an explicitly selected older
 * run in the list. Rejects runs owned by another account.
 */
export async function refreshCloud() {
  if (!allowed) return;
  cloudController?.abort();
  const controller = new AbortController();
  cloudController = controller;
  state.cloudLoading = true;
  state.cloudError = '';
  paint();
  try {
    const { runs, nextCursor } = await requestResearchHistory(controller.signal);
    if (controller.signal.aborted) return;
    if (runs.some((run) => run.ownerId !== ownerId))
      throw new Error('Saved research does not match this account.');
    // Keep an explicitly selected older run visible across a refresh.
    const retained = state.cloudRuns.find((run) => run.requestId === state.selectedId);
    state.cloudRuns =
      retained && !runs.some((run) => run.requestId === retained.requestId)
        ? [...runs, retained]
        : runs;
    state.cloudCursor = nextCursor ?? null;
    state.selectedId ||= runs[0]?.requestId || '';
  } catch {
    if (!controller.signal.aborted)
      state.cloudError =
        'Cloud research history is unavailable. Browser-only entries are not confirmed cloud saves.';
  } finally {
    if (!controller.signal.aborted) {
      state.cloudLoading = false;
      paint();
    }
  }
}

/** Fetches the next page of cloud research history and merges it into the loaded runs. */
export async function loadOlderResearch() {
  if (state.cloudLoading || state.cloudLoadingMore || !state.cloudCursor) return;
  const cursor = state.cloudCursor;
  state.cloudLoadingMore = true;
  state.cloudError = '';
  paint();
  try {
    const result = await requestResearchHistory(undefined, cursor);
    if (result.runs.some((run) => run.ownerId !== ownerId) || result.nextCursor === cursor)
      throw new Error('Saved research page could not be verified.');
    const merged = new Map(state.cloudRuns.map((run) => [run.requestId, run]));
    for (const run of result.runs) merged.set(run.requestId, run);
    state.cloudRuns = [...merged.values()];
    state.cloudCursor = result.nextCursor ?? null;
  } catch {
    state.cloudError =
      'Older saved research could not be loaded. Your displayed history is unchanged; try again.';
  } finally {
    state.cloudLoadingMore = false;
    paint();
  }
}
