/**
 * One trade form, used both to log a new trade in the Journal and to correct an
 * existing one from the Transactions ledger.
 *
 * Inputs are validated before any arithmetic runs, so a blank or malformed
 * price can never produce a NaN that contaminates the account balance. The
 * server repeats the same validation and recomputes the economics itself.
 */
import { t } from '../core/i18n.js';
import { h, input, select, textarea, label, fieldError, button } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import {
  economicsForTradeEdit,
  tradeEconomicsChanged,
  parsePositiveNumber,
  validateTradeInput,
  hasErrors,
} from '../../../shared/pnl.js';
import { todayInIst } from '../../../shared/market.js';
import {
  EMOTIONS,
  MISTAKE_SUGGESTIONS,
  SETUP_SUGGESTIONS,
  normalizeTags,
  parsePlannedRisk,
} from '../../../shared/trade-tags.js';
import {
  SEGMENTS,
  chargesForSegment,
  contractDetails,
  lotProblem,
} from '../../../shared/segments.js';
import { riskFromStop } from '../../../shared/trade-execution.js';
import { createExecutionSection } from './trade-form/execution.js';
import { confirmRows, previewPanel } from './trade-form/summary.js';

function initialState(trade) {
  return {
    date: trade?.date ?? todayInIst(),
    symbol: trade?.symbol ?? '',
    type: trade?.type ?? 'Long',
    entryPrice: trade ? String(trade.entryPrice) : '',
    exitPrice: trade ? String(trade.exitPrice) : '',
    quantity: trade ? String(trade.quantity) : '',
    notes: trade?.notes ?? '',
    strategyId: trade?.strategyId ?? '',
    setupTags: (trade?.setupTags ?? []).join(', '),
    mistakeTags: [...(trade?.mistakeTags ?? [])],
    emotion: trade?.emotion ?? '',
    plannedRisk: trade?.plannedRisk ? String(trade.plannedRisk) : '',
    segment: trade?.segment ?? 'EQ',
    lotSize: trade?.lotSize ? String(trade.lotSize) : '',
    expiry: trade?.expiry ?? '',
    strike: trade?.strike ? String(trade.strike) : '',
    optionType: trade?.optionType ?? 'CE',
  };
}

/**
 * @param {{ trade?: object, strategies: object[], settings: object, available?: boolean,
 *   onSubmitted?: (trade: object) => void, onCancel?: () => void, submitLabel?: string }} options
 */
export function createTradeForm({
  trade,
  strategies = [],
  settings,
  available = true,
  onSubmitted,
  onCancel,
  submitLabel,
}) {
  let form = initialState(trade);
  let errors = {};
  let submitError = null;
  let pending = false;
  const prefix = trade ? `edit-${trade.id.slice(0, 8)}` : 'trade';
  const id = (name) => `${prefix}-${name}`;

  const fields = {
    date: input({ id: id('date'), type: 'date', value: form.date }),
    symbol: input({ id: id('symbol'), placeholder: 'RELIANCE', value: form.symbol }),
    type: select({ id: id('type') }, [
      { value: 'Long', label: 'Long', selected: form.type === 'Long' },
      { value: 'Short', label: 'Short', selected: form.type === 'Short' },
    ]),
    quantity: input({
      id: id('qty'),
      type: 'number',
      step: '1',
      min: '1',
      placeholder: '100',
      value: form.quantity,
    }),
    entryPrice: input({
      id: id('entry'),
      type: 'number',
      step: 'any',
      min: '0',
      placeholder: '150.00',
      value: form.entryPrice,
    }),
    exitPrice: input({
      id: id('exit'),
      type: 'number',
      step: 'any',
      min: '0',
      placeholder: '155.00',
      value: form.exitPrice,
    }),
    notes: textarea({
      id: id('notes'),
      placeholder: t('Why did you take this trade? Did you follow your rules?'),
    }),
  };
  fields.notes.value = form.notes;
  fields.segment = select(
    { id: id('segment') },
    SEGMENTS.map((segment) => ({
      value: segment.value,
      label: segment.label,
      selected: segment.value === form.segment,
    })),
  );
  fields.lotSize = input({
    id: id('lot'),
    type: 'number',
    step: '1',
    min: '1',
    placeholder: '75',
    value: form.lotSize,
  });
  fields.expiry = input({ id: id('expiry'), type: 'date', value: form.expiry });
  fields.strike = input({
    id: id('strike'),
    type: 'number',
    step: 'any',
    min: '0',
    placeholder: '24500',
    value: form.strike,
  });
  fields.optionType = select({ id: id('option-type') }, [
    { value: 'CE', label: 'Call (CE)', selected: form.optionType === 'CE' },
    { value: 'PE', label: 'Put (PE)', selected: form.optionType === 'PE' },
  ]);
  fields.plannedRisk = input({
    id: id('risk'),
    type: 'number',
    step: 'any',
    min: '0',
    placeholder: t('e.g. 500'),
    value: form.plannedRisk,
  });
  const setupField = input({
    id: id('setup'),
    placeholder: t('Breakout, Opening range'),
    value: form.setupTags,
    list: id('setup-suggestions'),
    autocomplete: 'off',
  });
  const setupSuggestions = h(
    'datalist',
    { id: id('setup-suggestions') },
    SETUP_SUGGESTIONS.map((setup) => h('option', { value: setup })),
  );
  const emotionField = select(
    { id: id('emotion') },
    EMOTIONS.map((emotion) => ({
      value: emotion.value,
      label: emotion.label,
      selected: emotion.value === form.emotion,
    })),
  );
  const extraMistakes = form.mistakeTags.filter((tag) => !MISTAKE_SUGGESTIONS.includes(tag));
  const otherMistakesField = input({
    id: id('mistakes-other'),
    placeholder: t('Other mistakes, comma separated'),
    value: extraMistakes.join(', '),
  });
  // One toggle button per suggested mistake; pressed ones are saved as tags.
  const mistakeChips = MISTAKE_SUGGESTIONS.map((mistake) =>
    h(
      'button',
      {
        type: 'button',
        class:
          'focus-ring rounded-full border border-line-strong px-3 py-1 text-xs text-muted aria-pressed:border-negative aria-pressed:bg-negative-soft aria-pressed:text-negative',
        'aria-pressed': String(form.mistakeTags.includes(mistake)),
        'data-mistake': mistake,
        onclick: (event) => {
          const chip = event.currentTarget;
          chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
          read();
          paint();
        },
      },
      mistake,
    ),
  );
  const strategyField =
    strategies.length > 0
      ? select({ id: id('strategy') }, [
          { value: '', label: 'None', selected: !form.strategyId },
          ...strategies.map((strategy) => ({
            value: strategy.id,
            label: strategy.name,
            selected: strategy.id === form.strategyId,
          })),
        ])
      : null;

  const execution = createExecutionSection({
    trade,
    id,
    onChange: () => {
      read();
      paint();
    },
  });
  /** Execution details checked against the current direction, entry and quantity. */
  const executionResult = () =>
    execution.parse({
      type: form.type,
      entryPrice: Number(form.entryPrice),
      quantity: Number(form.quantity),
    });

  const errorSlots = {};
  const field = (key, labelText, element) => {
    errorSlots[key] = h('div');
    return h('div', { class: 'space-y-2' }, label(labelText, element.id), element, errorSlots[key]);
  };
  const previewBox = h('div');
  // Contract details appear only for futures and options.
  const contractBox = h('div', { class: 'grid grid-cols-1 gap-4 sm:grid-cols-2' });
  const submitErrorSlot = h('div');
  const submit = button(submitLabel ?? (trade ? 'Save changes' : 'Log trade'), {
    type: 'submit',
    className: 'flex-1',
  });
  const fieldset = h(
    'fieldset',
    { class: 'min-w-0 space-y-4', disabled: !available },
    h(
      'div',
      { class: 'grid grid-cols-1 gap-4 sm:grid-cols-2' },
      field('date', 'Date', fields.date),
      field('symbol', 'Symbol', fields.symbol),
      field('type', 'Direction', fields.type),
      field('quantity', 'Quantity', fields.quantity),
      field('entryPrice', 'Entry price', fields.entryPrice),
      field('exitPrice', 'Exit price', fields.exitPrice),
      field('segment', 'Segment', fields.segment),
    ),
    contractBox,
    strategyField
      ? h(
          'div',
          { class: 'space-y-2' },
          label(t('Strategy (optional)'), strategyField.id),
          strategyField,
        )
      : null,
    h(
      'div',
      { class: 'space-y-2' },
      label(t('Notes / reflections'), fields.notes.id),
      fields.notes,
    ),
    execution.element,
    h(
      'details',
      {
        class: 'rounded-control border border-line p-3',
        open: Boolean(
          form.setupTags || form.mistakeTags.length || form.emotion || form.plannedRisk,
        ),
      },
      h('summary', { class: 'cursor-pointer text-sm text-fg' }, 'Review (optional)'),
      h(
        'div',
        { class: 'mt-3 space-y-4' },
        h(
          'div',
          { class: 'space-y-2' },
          label(t('Setup tags'), setupField.id),
          setupField,
          setupSuggestions,
        ),
        h(
          'fieldset',
          { class: 'space-y-2' },
          h('legend', { class: 'text-sm text-fg' }, 'Mistakes'),
          h('div', { class: 'flex flex-wrap gap-2' }, mistakeChips),
          h(
            'label',
            { for: otherMistakesField.id, class: 'sr-only' },
            t('Other mistakes, comma separated'),
          ),
          otherMistakesField,
        ),
        h(
          'div',
          { class: 'grid grid-cols-1 gap-4 sm:grid-cols-2' },
          h('div', { class: 'space-y-2' }, label(t('Emotion'), emotionField.id), emotionField),
          field('plannedRisk', 'Planned risk (₹)', fields.plannedRisk),
        ),
        h(
          'p',
          { class: 'text-xs text-muted' },
          'Planned risk is what this trade would have lost at your stop. It turns P&L into R-multiples on the Insights page. Leave it empty to use the stop-loss price from Execution.',
        ),
      ),
    ),
    previewBox,
    submitErrorSlot,
    h(
      'div',
      { class: 'flex gap-2' },
      onCancel
        ? button(t('Cancel'), { variant: 'outline', className: 'flex-1', onclick: onCancel })
        : null,
      submit,
    ),
  );
  const element = h(
    'form',
    { class: 'space-y-4', novalidate: true },
    available
      ? null
      : h(
          'p',
          { role: 'alert', class: 'text-sm text-muted' },
          'Trade saving is paused because account data could not be loaded.',
        ),
    fieldset,
  );

  function read() {
    form = {
      date: fields.date.value,
      symbol: fields.symbol.value,
      type: fields.type.value,
      entryPrice: fields.entryPrice.value,
      exitPrice: fields.exitPrice.value,
      quantity: fields.quantity.value,
      notes: fields.notes.value,
      strategyId: strategyField ? strategyField.value : form.strategyId,
      setupTags: setupField.value,
      mistakeTags: normalizeTags([
        ...mistakeChips
          .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
          .map((chip) => chip.dataset.mistake),
        ...normalizeTags(otherMistakesField.value),
      ]),
      emotion: emotionField.value,
      plannedRisk: fields.plannedRisk.value,
      segment: fields.segment.value,
      lotSize: fields.lotSize.value,
      expiry: fields.expiry.value,
      strike: fields.strike.value,
      optionType: fields.optionType.value,
    };
    // Partial exits decide the exit price; it is shown but not typed.
    const parsed = executionResult();
    fields.exitPrice.readOnly = execution.hasLegs();
    if (parsed.exitPrice !== null) {
      fields.exitPrice.value = String(parsed.exitPrice);
      form.exitPrice = fields.exitPrice.value;
    }
  }

  const contractParts = {
    lotSize: field('lotSize', 'Lot size', fields.lotSize),
    expiry: field('expiry', 'Expiry', fields.expiry),
    strike: field('strike', 'Strike', fields.strike),
    optionType: field('optionType', 'Call / put', fields.optionType),
  };
  function paintContract() {
    const parts =
      form.segment === 'OPT'
        ? [
            contractParts.lotSize,
            contractParts.expiry,
            contractParts.strike,
            contractParts.optionType,
          ]
        : form.segment === 'FUT'
          ? [contractParts.lotSize, contractParts.expiry]
          : [];
    contractBox.hidden = parts.length === 0;
    contractBox.replaceChildren(...parts);
  }

  /** Core trade checks plus the planned-risk amount. */
  function validate() {
    const problems = validateTradeInput(form);
    if (parsePlannedRisk(form.plannedRisk) === undefined)
      problems.plannedRisk = 'Enter a positive amount in rupees, or leave it empty.';
    const contract = contractDetails(form);
    Object.assign(problems, contract.errors);
    const lots = lotProblem(form.quantity, contract.values.lotSize);
    if (lots && !problems.quantity) problems.quantity = lots;
    const executionErrors = executionResult().errors;
    execution.showErrors(executionErrors);
    Object.assign(problems, executionErrors);
    return problems;
  }

  function preview() {
    const entry = parsePositiveNumber(form.entryPrice);
    const exit = parsePositiveNumber(form.exitPrice);
    const quantity = parsePositiveNumber(form.quantity);
    if (entry === null || exit === null || quantity === null) return null;
    return economicsForTradeEdit(
      trade,
      {
        date: form.date,
        symbol: form.symbol,
        type: form.type,
        entryPrice: entry,
        exitPrice: exit,
        quantity,
        segment: form.segment,
        entryOrders: executionResult().values.entryOrders,
        exitOrders: executionResult().values.exitOrders,
        exitLegs: executionResult().values.exitLegs,
      },
      chargesForSegment(settings, form.segment),
    );
  }

  function paint() {
    paintContract();
    for (const key of Object.keys(errorSlots)) {
      const message = errors[key];
      const control = fields[key];
      control.classList.toggle('border-negative', Boolean(message));
      control.classList.toggle('border-line-strong', !message);
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
      errorSlots[key].replaceChildren(
        ...[fieldError(`${control.id}-error`, message)].filter(Boolean),
      );
    }
    submitErrorSlot.replaceChildren(
      ...[fieldError(id('submit-error'), submitError)].filter(Boolean),
    );
    const result = available ? preview() : null;
    if (!result) {
      previewBox.replaceChildren();
      return;
    }
    const changed =
      trade &&
      tradeEconomicsChanged(trade, {
        ...form,
        entryPrice: Number(form.entryPrice),
        exitPrice: Number(form.exitPrice),
        quantity: Number(form.quantity),
        entryOrders: executionResult().values.entryOrders,
        exitOrders: executionResult().values.exitOrders,
      });
    previewBox.replaceChildren(previewPanel(result, { editing: Boolean(trade), changed }));
  }

  element.addEventListener('input', () => {
    read();
    paint();
  });
  element.addEventListener('change', () => {
    read();
    paint();
  });

  async function save(close, confirmButton, cancelButton) {
    if (pending || !available) return;
    if (form.strategyId && !strategies.some((strategy) => strategy.id === form.strategyId)) {
      close();
      submitError =
        'The selected strategy is no longer available. Select a current strategy before saving.';
      paint();
      return;
    }
    const entry = parsePositiveNumber(form.entryPrice);
    const exit = parsePositiveNumber(form.exitPrice);
    const quantity = parsePositiveNumber(form.quantity);
    if (entry === null || exit === null || quantity === null) return;
    const body = {
      date: form.date,
      symbol: form.symbol,
      type: form.type,
      entryPrice: entry,
      exitPrice: exit,
      quantity,
      notes: form.notes,
      strategyId: form.strategyId || null,
      setupTags: normalizeTags(form.setupTags),
      mistakeTags: form.mistakeTags,
      emotion: form.emotion,
      plannedRisk: parsePlannedRisk(form.plannedRisk) ?? null,
      ...contractDetails(form).values,
      ...executionResult().values,
    };
    pending = true;
    fieldset.disabled = true;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    confirmButton.textContent = 'Saving…';
    try {
      const result = trade
        ? await api(`/api/trades/${encodeURIComponent(trade.id)}`, {
            method: 'PUT',
            body: { ...body, expectedOriginal: trade },
          })
        : await api('/api/trades', { method: 'POST', body });
      pending = false;
      close();
      onSubmitted?.(result.trade);
    } catch (error) {
      pending = false;
      close();
      submitError = errorMessage(error, 'Could not save the trade.');
      if (error?.payload?.fieldErrors) errors = error.payload.fieldErrors;
      paint();
    } finally {
      fieldset.disabled = !available;
    }
  }

  /** Planned risk as saved: entered, or implied by the stop-loss. */
  const plannedRiskShown = () =>
    parsePlannedRisk(form.plannedRisk) ??
    riskFromStop(Number(form.entryPrice), executionResult().values.stopLoss, Number(form.quantity));

  element.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending || !available) return;
    read();
    submitError = null;
    errors = validate();
    paint();
    if (hasErrors(errors)) return;
    const result = preview();
    const confirmButton = button(t('Confirm'), { className: 'flex-1' });
    const cancelButton = button(t('Cancel'), { variant: 'outline', className: 'flex-1' });
    openModal({
      title: t('Confirm trade'),
      content: (closeModal) => {
        cancelButton.addEventListener('click', () => {
          if (!pending) closeModal();
        });
        confirmButton.addEventListener(
          'click',
          () => void save(closeModal, confirmButton, cancelButton),
        );
        return h(
          'div',
          {},
          h(
            'div',
            { class: 'mb-8 space-y-2 tnum text-sm text-fg' },
            ...confirmRows(form, result, plannedRiskShown()),
          ),
          h('div', { class: 'flex gap-4' }, cancelButton, confirmButton),
        );
      },
    });
  });

  paint();
  return element;
}
