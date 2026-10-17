/**
 * Strategy evidence panel: saved backtest evidence and its append-only reviews.
 */
import {
  h,
  button,
  label,
  select,
  textarea,
  formatCurrency,
  render,
  downloadText,
} from '../core/dom.js';
import { notify, notifyError } from '../core/toast.js';
import { matchesStrategySnapshot, REVIEW_LABELS } from '../../../shared/strategy-evidence.js';
import {
  appendStrategyReview,
  listStrategyEvidence,
  listStrategyReviews,
} from '../lib/strategy-evidence.js';

/**
 * Saved backtest evidence with append-only owner reviews. Decisions are for
 * research only and never authorize orders.
 * @param {{ getStrategies: () => object[] }} options
 */
export function createStrategyEvidencePanel({ getStrategies }) {
  const state = { items: [], hasMore: false, loading: false, error: '', loaded: false };
  let pending = null;
  const list = h('div', { class: 'space-y-4' });
  const refresh = button('Refresh evidence', { variant: 'outline', onclick: () => void load() });
  const errorBox = h('p', { role: 'alert', class: 'mt-1 text-xs text-negative', hidden: true });
  const status = h('div');
  const more = h('div');
  const element = h(
    'section',
    {
      class: 'space-y-4 rounded-card border border-line p-4',
      'aria-label': 'Strategy research evidence',
    },
    h(
      'div',
      { class: 'flex flex-wrap items-center justify-between gap-3' },
      h('h2', { class: 'text-lg font-semibold' }, 'Strategy evidence & owner review'),
      refresh,
    ),
    h(
      'p',
      { class: 'text-sm text-muted' },
      'Attach a completed ',
      h('a', { href: '/backtest', class: 'underline' }, 'backtest'),
      ' to a saved strategy draft, then record your own review. Every revision needs its own evidence. These decisions are for research only and do not authorize orders.',
    ),
    h(
      'p',
      { class: 'text-xs text-muted' },
      'Paper trading and out-of-sample validation remain unverified. Saved simulations are computed in your browser; the archive does not independently verify market data or certify results.',
    ),
    errorBox,
    status,
    list,
    more,
  );

  async function load(before) {
    if (pending) return;
    const controller = new AbortController();
    pending = controller;
    state.loading = true;
    state.error = '';
    paint();
    try {
      const page = await listStrategyEvidence(before, controller.signal);
      if (!before) list.replaceChildren();
      state.items = before ? [...state.items, ...page.items] : page.items;
      for (const item of page.items) list.append(evidenceCard(item, getStrategies));
      state.hasMore = page.hasMore;
      state.loaded = true;
    } catch {
      if (!controller.signal.aborted)
        state.error =
          'Could not load saved research evidence. Retry after checking your account connection.';
    } finally {
      pending = null;
      state.loading = false;
      paint();
    }
  }

  function paint() {
    refresh.disabled = state.loading;
    errorBox.textContent = state.error;
    errorBox.hidden = !state.error;
    render(
      status,
      state.loading
        ? h('p', { role: 'status', class: 'text-sm text-muted' }, 'Loading research evidence…')
        : null,
      state.loaded && !state.items.length
        ? h(
            'p',
            { class: 'text-sm text-muted' },
            'No saved backtest evidence yet. Choose a saved draft before running a backtest, then save the completed evidence.',
          )
        : null,
    );
    render(
      more,
      state.hasMore
        ? button('Load older evidence', {
            variant: 'outline',
            disabled: state.loading,
            onclick: () => void load(state.items.at(-1)?.server_revision),
          })
        : null,
    );
  }

  void load();
  return element;
}

function evidenceCard(item, getStrategies) {
  let latest = item.latest_review ?? null;
  let saving = false;
  let retry = null;
  const history = { items: [], loaded: false, more: false, loading: false, error: '' };
  let historyRequest = null;
  const isCurrent = () =>
    matchesStrategySnapshot(
      getStrategies().find((strategy) => strategy.id === item.strategy_id),
      item.strategy_snapshot,
    );
  const current = isCurrent();

  const decision = select({ id: `decision-${item.id}` }, [
    { value: 'changes_requested', label: 'Request changes', selected: true },
    { value: 'approved_research', label: 'Approve for research only' },
    { value: 'revoked', label: 'Revoke research approval' },
  ]);
  for (const option of decision.options) if (option.value !== 'revoked') option.disabled = !current;
  const notes = textarea({ id: `notes-${item.id}`, maxlength: '4000' });
  const confirm = h('input', { type: 'checkbox', class: 'mt-1' });
  const saveButton = button('Save research review', { onclick: () => void save() });
  const fieldset = h(
    'fieldset',
    { class: 'mt-3 min-w-0 space-y-3' },
    h('div', {}, label('Research decision', decision.id), decision),
    h('div', {}, label('Review reasoning (10–4,000 characters)', notes.id), notes),
    h(
      'label',
      { class: 'flex items-start gap-2 text-sm' },
      confirm,
      h(
        'span',
        {},
        'I reviewed this exact strategy, simulation inputs and results. This is my research decision; paper trading, out-of-sample validation and execution permission are not certified.',
      ),
    ),
    saveButton,
  );
  const statusLine = h('p', { class: 'text-sm' });
  const latestNotes = h('div');
  const historyButton = button('Load review history', { variant: 'ghost' });
  const historyError = h('p', { role: 'alert', class: 'mt-1 text-xs text-negative', hidden: true });
  const historyList = h('div', { class: 'space-y-2' });

  const canSave = () =>
    confirm.checked &&
    notes.value.trim().length >= 10 &&
    (isCurrent() || decision.value === 'revoked');

  function paint() {
    statusLine.textContent = `${latest ? REVIEW_LABELS[latest.decision] : 'Unreviewed evidence'}${!current ? ' · historical draft only' : ''}`;
    render(
      latestNotes,
      latest
        ? h(
            'p',
            { class: 'whitespace-pre-wrap break-words text-sm' },
            `Latest loaded owner review: ${latest.notes}`,
          )
        : null,
    );
    fieldset.disabled = saving;
    saveButton.textContent = saving ? 'Saving review…' : 'Save research review';
    saveButton.disabled = !canSave();
    historyButton.disabled = saving || history.loading;
    historyButton.textContent = history.loading
      ? 'Loading reviews…'
      : history.loaded && history.more
        ? 'Load older reviews'
        : 'Load review history';
    historyError.textContent = history.error;
    historyError.hidden = !history.error;
    render(
      historyList,
      history.loaded && !history.items.length
        ? h('p', { class: 'text-sm text-muted' }, 'No owner reviews recorded.')
        : null,
      history.items.map((review) =>
        h(
          'p',
          { class: 'whitespace-pre-wrap break-words border-l border-line pl-3 text-sm' },
          `${new Date(review.created_at).toLocaleString('en-IN')} · ${REVIEW_LABELS[review.decision]}`,
          h('br'),
          review.notes,
        ),
      ),
    );
  }

  for (const control of [decision, notes, confirm]) {
    control.addEventListener('input', paint);
    control.addEventListener('change', paint);
  }

  async function save() {
    if (saving || !canSave()) return;
    const fingerprint = JSON.stringify([
      item.id,
      decision.value,
      notes.value.trim(),
      latest?.server_revision ?? 0,
    ]);
    // A retried request after an unknown outcome reuses its ID, so it can never append twice.
    if (retry?.fingerprint !== fingerprint) retry = { fingerprint, id: crypto.randomUUID() };
    saving = true;
    paint();
    try {
      const review = await appendStrategyReview({
        id: retry.id,
        evidenceId: item.id,
        decision: decision.value,
        notes: notes.value,
        expectedRevision: latest?.server_revision ?? 0,
        confirmed: confirm.checked,
      });
      if (review.server_revision > (latest?.server_revision ?? 0)) latest = review;
      notes.value = '';
      confirm.checked = false;
      historyRequest?.abort();
      historyRequest = null;
      Object.assign(history, { items: [], loaded: false, more: false, loading: false });
      retry = null;
      notify('Research review saved for this exact evidence. No orders are authorized.', 'success');
    } catch (error) {
      notifyError(
        error,
        'Could not save the review. Refresh evidence if another review was saved.',
      );
    } finally {
      saving = false;
      paint();
    }
  }

  historyButton.addEventListener('click', async () => {
    if (historyRequest || saving) return;
    const before =
      history.loaded && history.more ? history.items.at(-1)?.server_revision : undefined;
    const controller = new AbortController();
    historyRequest = controller;
    history.loading = true;
    history.error = '';
    paint();
    try {
      const page = await listStrategyReviews(item.id, before, controller.signal);
      if (controller.signal.aborted) return;
      history.items = before ? [...history.items, ...page.items] : page.items;
      history.more = page.hasMore;
      history.loaded = true;
    } catch {
      if (!controller.signal.aborted) history.error = 'Could not load review history. Try again.';
    } finally {
      if (historyRequest === controller) historyRequest = null;
      if (!controller.signal.aborted) history.loading = false;
      paint();
    }
  });

  const metrics = item.evidence.result.metrics;
  const element = h(
    'article',
    { class: 'min-w-0 space-y-3 rounded-card border border-line p-4' },
    h(
      'div',
      {},
      h(
        'h3',
        { class: 'break-words font-semibold' },
        `${item.strategy_snapshot.name} · ${item.evidence.symbol}`,
      ),
      statusLine,
      h(
        'p',
        { class: 'text-xs text-muted' },
        `Saved ${new Date(item.created_at).toLocaleString('en-IN')} · Draft ${item.strategy_id.slice(0, 8)}`,
      ),
    ),
    !current
      ? h(
          'p',
          { class: 'text-sm text-muted' },
          'This draft changed or was deleted. Its historical decision cannot approve a current revision. Existing approval can still be revoked.',
        )
      : null,
    h(
      'p',
      { class: 'text-sm' },
      `${item.evidence.from} to ${item.evidence.to} (end excluded) · ${item.evidence.candles.length} daily candles · ${metrics.totalTrades} simulated trades · Net ${formatCurrency(metrics.netProfit)} · Max drawdown ${metrics.maxDrawdownPercent}%`,
    ),
    h(
      'details',
      { class: 'space-y-2 text-sm' },
      h('summary', { class: 'cursor-pointer' }, 'Review frozen strategy, inputs and hashes'),
      h('p', { class: 'whitespace-pre-wrap break-words' }, item.strategy_snapshot.rules),
      h('p', { class: 'whitespace-pre-wrap break-words' }, item.strategy_snapshot.improvements),
      h('p', { class: 'whitespace-pre-wrap break-words' }, item.strategy_snapshot.notes),
      h(
        'pre',
        { class: 'max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs' },
        JSON.stringify(
          { params: item.evidence.params, config: item.evidence.config, metrics },
          null,
          2,
        ),
      ),
      h('p', { class: 'break-all text-xs' }, `Strategy SHA-256: ${item.strategy_hash}`),
      h('p', { class: 'break-all text-xs' }, `Evidence SHA-256: ${item.evidence_hash}`),
      h(
        'p',
        { class: 'text-xs text-muted' },
        `Daily, long-only, next-open fills; stop first when a candle reaches both exits; no slippage. Engine ${item.evidence.engineVersion}.`,
      ),
      button('Download complete evidence JSON', {
        variant: 'outline',
        onclick: () =>
          downloadText(
            `strategy-evidence-${item.id}.json`,
            JSON.stringify({ ...item, latest_review: latest }, null, 2),
            'application/json',
          ),
      }),
    ),
    latestNotes,
    h(
      'details',
      {},
      h('summary', { class: 'cursor-pointer text-sm' }, 'Record an owner review'),
      fieldset,
    ),
    h('div', { class: 'space-y-2' }, historyButton, historyError, historyList),
  );
  paint();
  return element;
}
