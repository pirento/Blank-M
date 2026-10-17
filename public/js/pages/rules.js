/**
 * Rules page: add, edit, reorder and delete trading rules by section.
 */
import {
  $,
  h,
  icon,
  pageData,
  button,
  input,
  textarea,
  label,
  card,
  emptyState,
  render,
} from '../core/dom.js';
import { api } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify, notifyError } from '../core/toast.js';
import { requestRuleDraft } from '../lib/ai.js';
import { aiGate } from '../components/ai-gate.js';

const data = pageData();
const state = { rules: data.workspace?.rules ?? [] };

function ruleCard(rule) {
  return card(
    { className: 'min-w-0' },
    h(
      'div',
      { class: 'p-6' },
      h(
        'div',
        { class: 'mb-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-start sm:justify-between' },
        h(
          'h3',
          {
            class:
              'min-w-0 text-xl font-normal tracking-tight text-accent [overflow-wrap:anywhere] sm:flex-1',
          },
          rule.section,
        ),
        h(
          'div',
          { class: 'flex shrink-0 gap-2 self-end sm:self-auto' },
          button('Edit', {
            variant: 'ghost',
            size: 'sm',
            'aria-label': `Edit rule ${rule.section}`,
            onclick: () => openEditor(rule),
          }),
          button(icon('trash-2', 16), {
            variant: 'ghost',
            size: 'sm',
            className: 'text-negative hover:bg-negative-soft',
            'aria-label': `Delete rule ${rule.section}`,
            onclick: () => confirmDelete(rule),
          }),
        ),
      ),
      h(
        'div',
        { class: 'mb-4' },
        h('p', { class: 'mt-1 text-sm text-muted [overflow-wrap:anywhere]' }, rule.definition),
      ),
      h(
        'div',
        { class: 'border-l-4 border-black bg-elevated p-4' },
        h('p', { class: 'font-medium whitespace-pre-wrap [overflow-wrap:anywhere]' }, rule.rule),
      ),
    ),
  );
}

function paint() {
  render(
    $('[data-rules]'),
    state.rules.length === 0
      ? emptyState({
          iconName: 'shield-check',
          title: 'Your constitution is empty',
          hint: 'Add rules to govern your trading behaviour',
        })
      : h('div', { class: 'space-y-6' }, state.rules.map(ruleCard)),
  );
}

function openEditor(rule = null) {
  let draftRequest = null;
  let saving = false;
  let closed = false;
  const section = input({
    id: 'r-section',
    placeholder: 'e.g. I. Risk Management',
    value: rule?.section ?? '',
  });
  const definition = textarea({
    id: 'r-definition',
    placeholder: 'What does this rule protect or define?',
  });
  const ruleText = textarea({
    id: 'r-rule',
    className: 'min-h-[120px]',
    placeholder: 'The unshakeable law…',
  });
  definition.value = rule?.definition ?? '';
  ruleText.value = rule?.rule ?? '';
  const errorBox = h('p', { role: 'alert', class: 'mt-1 text-xs text-negative', hidden: true });
  const setError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  };
  const form = () => ({
    section: section.value,
    definition: definition.value,
    rule: ruleText.value,
  });
  const assistButton = button([icon('bot', 16, 'mr-2'), 'AI assist'], { variant: 'primary' });
  const saveButton = button([icon('save', 16, 'mr-2'), 'Save rule']);
  const sync = () => {
    const generating = Boolean(draftRequest);
    render(
      assistButton,
      icon(generating ? 'loader-2' : 'bot', 16, generating ? 'mr-2 animate-spin' : 'mr-2'),
      'AI assist',
    );
    render(saveButton, icon('save', 16, 'mr-2'), saving ? 'Saving…' : 'Save rule');
    assistButton.disabled = generating || saving;
    saveButton.disabled = generating || saving;
    for (const field of [section, definition, ruleText]) field.disabled = saving;
  };
  const cancelDraft = () => {
    draftRequest?.abort();
    draftRequest = null;
    sync();
  };
  // Typing expresses newer intent than an outstanding AI suggestion.
  for (const field of [section, definition, ruleText]) field.addEventListener('input', cancelDraft);

  const { close } = openModal({
    title: rule ? 'Edit rule' : 'Draft new rule',
    onClose: () => {
      closed = true;
      draftRequest?.abort();
    },
    content: (closeModal) =>
      h(
        'div',
        { class: 'max-h-[70vh] space-y-4 overflow-y-auto pr-1' },
        errorBox,
        h('div', { class: 'space-y-2' }, label('Article / section', 'r-section'), section),
        h('div', { class: 'space-y-2' }, label('Definition / concept', 'r-definition'), definition),
        h('div', { class: 'space-y-2' }, label('The rule', 'r-rule'), ruleText),
        h(
          'div',
          { class: 'flex flex-wrap justify-between gap-2 pt-2' },
          button('Cancel', { variant: 'outline', onclick: closeModal }),
          h(
            'div',
            { class: 'flex min-w-0 flex-wrap gap-2' },
            aiGate(data.health, 'AI assist', assistButton),
            saveButton,
          ),
        ),
      ),
  });

  assistButton.addEventListener('click', async () => {
    if (draftRequest || saving) return;
    const current = form();
    if (!current.section.trim() && !current.definition.trim() && !current.rule.trim()) {
      setError('Give the AI a section, definition or draft rule to work from.');
      return;
    }
    setError('');
    const controller = new AbortController();
    draftRequest = controller;
    sync();
    try {
      // The response is schema-validated server-side, so it cannot arrive as half-parsed text.
      const drafted = await requestRuleDraft(current, controller.signal);
      if (closed || controller.signal.aborted || draftRequest !== controller) return;
      section.value = drafted.section;
      definition.value = drafted.definition;
      ruleText.value = drafted.rule;
    } catch (error) {
      if (!closed && !controller.signal.aborted && draftRequest === controller)
        notifyError(error, 'Could not draft the rule.');
    } finally {
      if (draftRequest === controller) {
        draftRequest = null;
        if (!closed) sync();
      }
    }
  });

  saveButton.addEventListener('click', async () => {
    if (saving || draftRequest) return;
    const value = form();
    if (!value.section.trim() || !value.definition.trim() || !value.rule.trim()) {
      setError('Fill in the section, definition and rule.');
      return;
    }
    saving = true;
    sync();
    try {
      if (rule) {
        const result = await api(`/api/rules/${encodeURIComponent(rule.id)}`, {
          method: 'PUT',
          body: value,
        });
        state.rules = state.rules.map((entry) => (entry.id === rule.id ? result.rule : entry));
      } else {
        const result = await api('/api/rules', { method: 'POST', body: value });
        state.rules = [...state.rules, result.rule];
      }
      close();
      notify(rule ? 'Rule updated.' : 'Rule added.', 'success');
      paint();
    } catch (error) {
      notifyError(error, 'Could not save the rule.');
    } finally {
      saving = false;
      if (!closed) sync();
    }
  });
}

function confirmDelete(rule) {
  openModal({
    title: 'Delete rule',
    content: (close) => {
      const remove = button('Delete', { variant: 'destructive', className: 'flex-1' });
      remove.addEventListener('click', async () => {
        if (remove.disabled) return;
        remove.disabled = true;
        remove.textContent = 'Deleting…';
        try {
          await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
          state.rules = state.rules.filter((entry) => entry.id !== rule.id);
          notify('Rule deleted.', 'success');
          paint();
        } catch (error) {
          notifyError(error, 'Could not delete the rule.');
        } finally {
          close();
        }
      });
      return h(
        'div',
        {},
        h(
          'p',
          { class: 'mb-6 text-sm text-muted [overflow-wrap:anywhere]' },
          `Delete “${rule.section}” from your constitution?`,
        ),
        h(
          'div',
          { class: 'flex gap-4' },
          button('Cancel', { variant: 'outline', className: 'flex-1', onclick: close }),
          remove,
        ),
      );
    },
  });
}

$('[data-add-rule]').addEventListener('click', () => openEditor());
paint();
