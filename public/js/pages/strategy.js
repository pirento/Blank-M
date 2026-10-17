/**
 * Strategy manager. Each strategy shows the realised performance of the trades
 * logged against it, so the record is measured rather than just written down.
 * Revisions are saved as new records; the previous draft is always retained.
 */
import {
  $,
  h,
  pageData,
  button,
  buttonClass,
  input,
  textarea,
  label,
  select,
  emptyState,
  render,
} from '../core/dom.js';
import { api } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify, notifyError } from '../core/toast.js';
import { todayInIst } from '../../../shared/market.js';
import { isBusinessDate } from '../../../shared/business-dates.js';
import { createStrategyEvidencePanel } from '../components/strategy-evidence-panel.js';
import { strategyCard } from './strategy/strategy-card.js';

const data = pageData();
const workspace = data.workspace;
const available = Boolean(workspace);
const state = {
  strategies: workspace?.strategies ?? [],
  rules: workspace?.rules ?? [],
  trades: workspace?.trades ?? [],
};

async function addStrategy(payload) {
  const result = await api('/api/strategies', { method: 'POST', body: payload });
  state.strategies = [result.strategy, ...state.strategies];
  return result.strategy;
}

/* ----------------------------- written strategy editors ---------------------------- */

const editors = {
  strategyId: state.strategies[0]?.id || '',
  ruleId: state.rules[0]?.id || '',
  originalRule: state.rules[0]?.rule || '',
  savingStrategy: false,
  savingRules: false,
};

const strategyName = input({
  id: 'written-strategy-name',
  maxlength: '120',
  value: state.strategies[0]?.name || '',
});
const strategyConditions = textarea({
  id: 'written-strategy-conditions',
  placeholder: 'Record the conditions you want to test…',
});
strategyConditions.value = state.strategies[0]?.rules || '';
const strategySource = h('div');
const strategyError = h('p', { role: 'alert', class: 'mt-1 text-xs text-negative', hidden: true });
const saveStrategyButton = button('Save strategy draft');
const ruleText = textarea({ id: 'written-trading-rules', maxlength: '4000' });
ruleText.value = state.rules[0]?.rule || '';
const ruleSource = h('div');
const rulesError = h('p', { role: 'alert', class: 'mt-1 text-xs text-negative', hidden: true });
const saveRulesButton = button('Save rules');
const setMessage = (element, message) => {
  element.textContent = message;
  element.hidden = !message;
};

function paintEditors() {
  render(
    strategySource,
    state.strategies.length > 0
      ? (() => {
          const picker = select(
            { id: 'written-strategy-source', disabled: editors.savingStrategy },
            [
              { value: '', label: 'New strategy', selected: !editors.strategyId },
              ...state.strategies.map((strategy) => ({
                value: strategy.id,
                label: `${strategy.name} · ${strategy.date}`,
                selected: strategy.id === editors.strategyId,
              })),
            ],
          );
          picker.addEventListener('change', () => {
            const selected = state.strategies.find((strategy) => strategy.id === picker.value);
            editors.strategyId = picker.value;
            strategyName.value = selected?.name || '';
            strategyConditions.value = selected?.rules || '';
            setMessage(strategyError, '');
          });
          return h('div', {}, label('Draft to revise', picker.id), picker);
        })()
      : null,
  );
  render(
    ruleSource,
    state.rules.length > 0
      ? (() => {
          const picker = select({ id: 'written-rules-source', disabled: editors.savingRules }, [
            { value: '', label: 'New rules document', selected: !editors.ruleId },
            ...state.rules.map((rule) => ({
              value: rule.id,
              label: rule.section,
              selected: rule.id === editors.ruleId,
            })),
          ]);
          picker.addEventListener('change', () => {
            const selected = state.rules.find((rule) => rule.id === picker.value);
            editors.ruleId = picker.value;
            ruleText.value = selected?.rule || '';
            editors.originalRule = selected?.rule || '';
            setMessage(rulesError, '');
          });
          return h('div', {}, label('Rules document', picker.id), picker);
        })()
      : null,
  );
  strategyName.disabled = strategyConditions.disabled = editors.savingStrategy;
  saveStrategyButton.disabled = editors.savingStrategy;
  saveStrategyButton.textContent = editors.savingStrategy ? 'Saving…' : 'Save strategy draft';
  ruleText.disabled = editors.savingRules;
  saveRulesButton.disabled = editors.savingRules;
  saveRulesButton.textContent = editors.savingRules ? 'Saving…' : 'Save rules';
}

saveStrategyButton.addEventListener('click', async () => {
  if (editors.savingStrategy) return;
  const name = strategyName.value.trim();
  const conditions = strategyConditions.value.trim();
  if (name.length < 3 || name.length > 120 || conditions.length < 10) {
    setMessage(
      strategyError,
      'Use a name of 3 to 120 characters and conditions of at least 10 characters.',
    );
    return;
  }
  const previous = state.strategies.find((strategy) => strategy.id === editors.strategyId);
  if (editors.strategyId && !previous) {
    setMessage(
      strategyError,
      'The selected draft is no longer available. Select a current draft or start a new one.',
    );
    return;
  }
  if (previous?.name === name && previous.rules === conditions) {
    notify('No strategy changes to save.', 'info');
    return;
  }
  editors.savingStrategy = true;
  setMessage(strategyError, '');
  paintEditors();
  try {
    const saved = await addStrategy({
      date: todayInIst(),
      name,
      rules: conditions,
      improvements: previous?.improvements || '',
      notes: previous
        ? `Revision of ${previous.name} (${previous.id}). Previous record retained.\n${previous.notes}`
        : '',
    });
    editors.strategyId = saved.id;
    notify(
      previous
        ? 'Strategy revision saved. The previous draft is retained.'
        : 'Strategy draft saved.',
      'success',
    );
    paintLibrary();
  } catch (error) {
    notifyError(error, 'Could not save the strategy draft.');
  } finally {
    editors.savingStrategy = false;
    paintEditors();
  }
});

saveRulesButton.addEventListener('click', async () => {
  if (editors.savingRules) return;
  const text = ruleText.value.trim();
  if (!text || text.length > 4000) {
    setMessage(rulesError, 'Write at least one trading rule, using at most 4,000 characters.');
    return;
  }
  const previous = state.rules.find((rule) => rule.id === editors.ruleId);
  if (editors.ruleId && !previous) {
    setMessage(
      rulesError,
      'The selected rules are no longer available. Reload the current rules before saving.',
    );
    return;
  }
  if (previous && previous.rule !== editors.originalRule) {
    setMessage(
      rulesError,
      'These rules changed while you were editing. Select the current document again before saving.',
    );
    return;
  }
  editors.savingRules = true;
  setMessage(rulesError, '');
  paintEditors();
  try {
    const payload = {
      section: previous?.section || 'Trading rules',
      definition: previous?.definition || 'Written rules for reviewing a trade plan.',
      rule: text,
    };
    const result = previous
      ? await api(`/api/rules/${encodeURIComponent(previous.id)}`, { method: 'PUT', body: payload })
      : await api('/api/rules', { method: 'POST', body: payload });
    state.rules = previous
      ? state.rules.map((rule) => (rule.id === previous.id ? result.rule : rule))
      : [...state.rules, result.rule];
    notify('Trading rules saved.', 'success');
    editors.originalRule = text;
    editors.ruleId = result.rule.id;
  } catch (error) {
    notifyError(error, 'Could not save the trading rules.');
  } finally {
    editors.savingRules = false;
    paintEditors();
  }
});

function mountEditors() {
  render(
    $('[data-written-editors]'),
    h(
      'div',
      { class: 'rr-columns' },
      h(
        'section',
        { class: 'rr-panel' },
        h('h2', {}, 'Your written strategy'),
        h(
          'div',
          { class: 'rr-fields' },
          strategySource,
          h('div', {}, label('Strategy name', strategyName.id), strategyName),
          h(
            'div',
            {},
            label('Entry, exit and invalidation conditions', strategyConditions.id),
            strategyConditions,
          ),
          strategyError,
          h('div', {}, saveStrategyButton),
        ),
        h(
          'p',
          { class: 'rr-muted' },
          'Saved to your account as a research draft. Each revision preserves the previous record. No trading rules execute automatically.',
        ),
      ),
      h(
        'section',
        { class: 'rr-panel' },
        h('h2', {}, 'Trading rules'),
        h(
          'div',
          { class: 'rr-fields' },
          ruleSource,
          h('div', {}, label('One rule per line', ruleText.id), ruleText),
          rulesError,
          h('div', {}, saveRulesButton),
        ),
        h(
          'p',
          { class: 'rr-muted' },
          'Saved plans retain the rules captured when they were prepared. ',
          h('a', { href: '/rules', class: 'underline' }, 'Manage all rule documents'),
          '.',
        ),
      ),
    ),
    h(
      'section',
      { class: 'rr-panel' },
      h('h2', {}, 'Strategy promotion'),
      h(
        'p',
        { class: 'rr-muted' },
        'Draft → backtest → out-of-sample review → paper trading → your approval → active version.',
      ),
      h(
        'p',
        {},
        'AI suggestions must preserve the previous strategy version and show the evidence for each change.',
      ),
      h(
        'p',
        { class: 'rr-muted' },
        'Set each strategy’s stage on its card below; every change is kept with its date. A stage is your own record, not an approval for automatic execution.',
      ),
      h(
        'div',
        { class: 'rr-pair' },
        h('a', { href: '/analytics', class: buttonClass('outline') }, 'Discuss a strategy'),
        h('a', { href: '/backtest', class: 'text-sm text-muted underline' }, 'Open backtest'),
      ),
    ),
  );
  paintEditors();
}

/* ------------------------------------ library ------------------------------------- */

function paintLibrary() {
  $('[data-library-summary]').textContent =
    `Strategy library · ${available ? `${state.strategies.length} saved drafts` : 'unavailable'}`;
  render(
    $('[data-library]'),
    !available
      ? h('p', { class: 'rr-muted' }, 'Saved drafts are unavailable until your account data loads.')
      : state.strategies.length === 0
        ? emptyState({
            iconName: 'lightbulb',
            title: 'No strategies yet',
            hint: 'Write down the rules you actually trade',
          })
        : h(
            'div',
            { class: 'grid grid-cols-1 gap-6 lg:grid-cols-2' },
            state.strategies.map((strategy) =>
              strategyCard(strategy, {
                trades: state.trades,
                available,
                onEdit: openEditor,
                onDelete: confirmDelete,
                onChanged: (saved) => {
                  state.strategies = state.strategies.map((entry) =>
                    entry.id === saved.id ? saved : entry,
                  );
                  paintLibrary();
                },
              }),
            ),
          ),
  );
}

function openEditor(strategy = null) {
  let saving = false;
  const fields = {
    date: input({ id: 's-date', type: 'date', value: strategy?.date ?? todayInIst() }),
    name: input({
      id: 's-name',
      maxlength: '120',
      placeholder: 'e.g. Morning Breakout',
      value: strategy?.name ?? '',
    }),
    rules: textarea({ id: 's-rules', className: 'min-h-[120px]' }),
    improvements: textarea({ id: 's-improvements' }),
    notes: textarea({ id: 's-notes' }),
  };
  fields.rules.value = strategy?.rules ?? '';
  fields.improvements.value = strategy?.improvements ?? '';
  fields.notes.value = strategy?.notes ?? '';
  const errorBox = h('p', { role: 'alert', class: 'mt-1 text-xs text-negative', hidden: true });
  const saveButton = button('Save', { className: 'flex-1' });
  const fieldset = h(
    'fieldset',
    { class: 'min-w-0 max-h-[70vh] space-y-4 overflow-y-auto pr-1' },
    errorBox,
    h('div', { class: 'space-y-2' }, label('Date', 's-date'), fields.date),
    h('div', { class: 'space-y-2' }, label('Name', 's-name'), fields.name),
    h('div', { class: 'space-y-2' }, label('Rules', 's-rules'), fields.rules),
    h('div', { class: 'space-y-2' }, label('Improvements', 's-improvements'), fields.improvements),
    h('div', { class: 'space-y-2' }, label('Notes', 's-notes'), fields.notes),
  );
  const { close } = openModal({
    title: strategy ? 'Edit strategy' : 'New strategy',
    content: (closeModal) => {
      fieldset.append(
        h(
          'div',
          { class: 'flex gap-4 pt-2' },
          button('Cancel', {
            variant: 'outline',
            className: 'flex-1',
            onclick: () => !saving && closeModal(),
          }),
          saveButton,
        ),
      );
      return fieldset;
    },
  });
  saveButton.addEventListener('click', async () => {
    if (saving) return;
    const name = fields.name.value.trim();
    const rules = fields.rules.value.trim();
    const fail = (message) => {
      errorBox.textContent = message;
      errorBox.hidden = false;
    };
    if (name.length < 3 || name.length > 120)
      return fail('Strategy name must be between 3 and 120 characters long.');
    if (!isBusinessDate(fields.date.value)) return fail('Choose a valid strategy date.');
    if (rules.length < 10) return fail('Rules must be at least 10 characters long.');
    saving = true;
    fieldset.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const original = strategy ? state.strategies.find((entry) => entry.id === strategy.id) : null;
      if (strategy && !original)
        throw new Error('This strategy is no longer available. Reopen a current draft.');
      await addStrategy({
        date: fields.date.value,
        name,
        rules,
        improvements: fields.improvements.value,
        notes: original
          ? `Revision of ${original.name} (${original.id}). Previous record retained.\n${fields.notes.value}`
          : fields.notes.value,
      });
      close();
      notify(
        strategy ? 'Strategy revision saved. Previous draft retained.' : 'Strategy saved.',
        'success',
      );
      paintLibrary();
      paintEditors();
    } catch (error) {
      notifyError(error, 'Could not save the strategy.');
    } finally {
      saving = false;
      fieldset.disabled = false;
      saveButton.textContent = 'Save';
    }
  });
}

function confirmDelete(strategy) {
  openModal({
    title: 'Delete strategy',
    content: (close) => {
      const remove = button('Delete', { variant: 'destructive', className: 'flex-1' });
      const cancel = button('Cancel', { variant: 'outline', className: 'flex-1', onclick: close });
      remove.addEventListener('click', async () => {
        remove.disabled = cancel.disabled = true;
        remove.textContent = 'Deleting…';
        try {
          await api(`/api/strategies/${encodeURIComponent(strategy.id)}`, { method: 'DELETE' });
          state.strategies = state.strategies.filter((entry) => entry.id !== strategy.id);
          // Trades tagged with it are kept, but unlinked.
          state.trades = state.trades.map((trade) =>
            trade.strategyId === strategy.id ? { ...trade, strategyId: null } : trade,
          );
          if (editors.strategyId === strategy.id) editors.strategyId = '';
          notify('Strategy deleted.', 'success');
          paintLibrary();
          paintEditors();
        } catch (error) {
          notifyError(error, 'Could not delete the strategy.');
        } finally {
          close();
        }
      });
      return h(
        'div',
        {},
        h(
          'p',
          { class: 'mb-6 text-sm text-muted' },
          `Delete “${strategy.name}”? Trades tagged with it are kept, but they will no longer be linked to a strategy.`,
        ),
        h('div', { class: 'flex gap-4' }, cancel, remove),
      );
    },
  });
}

$('[data-new-strategy]').addEventListener('click', () => openEditor());
if (available) {
  mountEditors();
  render(
    $('[data-evidence-panel]'),
    createStrategyEvidencePanel({ getStrategies: () => state.strategies }),
  );
}
paintLibrary();
