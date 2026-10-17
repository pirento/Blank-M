/**
 * Switches between the planning and journal report.
 */
import { $, $$, buttonClass } from '../../core/dom.js';

/** Switches between the planning and journal reports: toggles the source buttons and sections. */
export function setSource(source) {
  for (const control of $$('[data-source]')) {
    const active = control.dataset.source === source;
    control.setAttribute('aria-pressed', String(active));
    control.className = buttonClass(active ? 'primary' : 'outline');
  }
  $('[data-planning]').hidden = source !== 'planning';
  $('[data-journal]').hidden = source !== 'journal';
}
