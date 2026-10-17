/**
 * Form fields: number and select inputs bound to the calculator state.
 */
import { h, input, select, label as fieldLabel } from '../../core/dom.js';
import { paintEstimate, paintModes } from './painting.js';
import { errorElements, fields, inputs, state } from './shared.js';

/**
 * Builds a labelled text input for a calculator field, with hint and error slots, and
 * registers it in `inputs`/`errorElements`. Typing calls `update()`.
 */
export function numberField(field, labelText, hint, disabled = false) {
  const id = `calc-${field}`;
  const control = input({
    id,
    type: 'text',
    inputmode: field === 'quantity' ? 'numeric' : 'decimal',
    value: field === 'rewardMultiple' ? state.customReward : (fields[field] ?? ''),
    placeholder:
      field === 'quantity'
        ? 'Automatic'
        : field === 'estimatedRoundTripCharges'
          ? 'From Settings'
          : undefined,
    disabled,
  });
  control.addEventListener('input', () => {
    if (field === 'rewardMultiple') {
      state.customReward = control.value;
      if (state.rewardPreset === 'custom') update(field, control.value);
    } else update(field, control.value);
  });
  inputs[field] = control;
  errorElements[field] = h('p', {
    id: `${id}-error`,
    role: 'alert',
    class: 'mt-1 text-xs text-negative',
    hidden: true,
  });
  return h(
    'div',
    { class: 'min-w-0 space-y-2', dataset: { field } },
    fieldLabel(labelText, id),
    control,
    hint ? h('p', { id: `${id}-hint`, class: 'text-xs text-muted' }, hint) : null,
    errorElements[field],
  );
}

/** Builds a labelled select; returns both the control and its wrapper element. */
export function selectField(id, labelText, options, value, onChange) {
  const control = select(
    { id },
    options.map(([optionValue, text]) => ({
      value: optionValue,
      label: text,
      selected: optionValue === value,
    })),
  );
  control.addEventListener('change', () => onChange(control.value));
  return {
    control,
    element: h('div', { class: 'min-w-0 space-y-2' }, fieldLabel(labelText, id), control),
  };
}

/**
 * Stores a field value, marks it edited and repaints the estimate. Choosing CNC forces
 * margin to 100%; editing capital bumps the revision so an in-flight balance sync is ignored.
 */
export function update(field, value) {
  if (field === 'entryPrice') state.entryEdited = true;
  if (field === 'accountSize' || field === 'availableCapital') state.capitalRevision += 1;
  fields[field] = value;
  if (field === 'product' && value === 'CNC') {
    fields.marginPercent = '100';
    inputs.marginPercent.value = '100';
  }
  state.edited[field] = true;
  state.saveError = null;
  paintModes();
  paintEstimate();
}

/** Sets the entry price in both the field state and its input, without marking it edited. */
export function setEntry(value) {
  fields.entryPrice = value;
  inputs.entryPrice.value = value;
}
