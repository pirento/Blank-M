/** Shared state and small helpers used by more than one section of this page. */
import { h, pageData } from '../../core/dom.js';
import { DEFAULT_CHARGES } from '../../../../shared/types.js';

export const data = pageData();

export const workspace = data.workspace;

export const available = Boolean(workspace);

export const settings = workspace?.settings ?? {
  openingBalance: 0,
  charges: { ...DEFAULT_CHARGES },
};

/** Muted paragraph used under a settings card title. */
export const cardDescription = (text) => h('p', { class: 'mt-1 text-sm text-muted' }, text);

export { errorLine, statusLine } from '../../core/dom.js';

/** Small label-over-value block for showing a single fact. */
export const plainFact = (text, value) =>
  h(
    'div',
    {},
    h('p', { class: 'text-xs text-subtle' }, text),
    h('p', { class: 'tnum mt-1 font-semibold text-fg' }, value),
  );
