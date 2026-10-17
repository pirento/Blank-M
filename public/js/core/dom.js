/**
 * Small DOM helpers used by every page module (no UI framework).
 * `h()` builds elements from a tag, attributes and children; text is always
 * inserted as text nodes, so user data can never become markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOOLEAN_PROPS = new Set([
  'disabled',
  'checked',
  'selected',
  'hidden',
  'required',
  'multiple',
]);

/**
 * Create an element. Attributes: `class`/`className`, `style` object, `dataset` object,
 * `onX` functions become listeners, boolean props are set as properties; null, undefined
 * and false are skipped. Children are appended as with append().
 */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') element.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function')
      element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') element.value = value;
    else if (BOOLEAN_PROPS.has(key)) element[key] = Boolean(value);
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

/**
 * Append children (nested arrays are flattened) to parent, skipping null, undefined,
 * false and ''. Non-nodes become text nodes. Returns parent.
 */
export function append(parent, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace an element's children. */
export function render(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

/** A Lucide icon from the server-generated sprite. Decorative unless labelled. */
export function icon(name, size = 16, className = '', label = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `lucide lucide-${name} ${className}`.trim());
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Join truthy class names (arrays are flattened) into one class string. */
export function cn(...parts) {
  return parts.flat().filter(Boolean).join(' ');
}

const currency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** Format a number as Indian rupees with two decimals, e.g. "₹1,23,456.00". */
export function formatCurrency(amount) {
  return currency.format(amount);
}

/** Date and time in India Standard Time, e.g. "11/10/2026, 9:15:00 am" (no suffix). */
export function formatIstDateTime(value) {
  return new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

/** A polite status paragraph, or nothing when there is no text. */
export const statusLine = (text, role = 'status', className = 'text-sm') =>
  text ? h('p', { role, class: className }, text) : null;

/** An error paragraph announced to screen readers, or nothing when there is no text. */
export const errorLine = (text) =>
  text ? h('p', { role: 'alert', class: 'text-sm text-negative' }, text) : null;

/** The JSON a server-rendered page embedded for its browser module. */
export function pageData() {
  const element = document.getElementById('page-data');
  if (!element) return null;
  try {
    return JSON.parse(element.textContent || 'null');
  } catch {
    return null;
  }
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  default: 'bg-accent text-accent-fg hover:bg-accent-hover',
  outline: 'border border-line-strong bg-surface text-fg hover:bg-elevated',
  ghost: 'text-muted hover:bg-elevated hover:text-fg',
  destructive: 'bg-negative text-white hover:opacity-90',
};
const BUTTON_SIZES = {
  sm: 'min-h-9 px-3 text-xs',
  default: 'min-h-10 px-4 text-sm',
  lg: 'min-h-12 px-6 text-sm',
  icon: 'h-10 w-10',
};
const BUTTON_BASE =
  'inline-flex items-center justify-center rounded-control font-normal whitespace-nowrap transition-[background-color,color,border-color,transform,box-shadow] active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

/** Class string for a button of the given variant and size, for elements styled as buttons. */
export function buttonClass(variant = 'default', size = 'default', className = '') {
  return cn(BUTTON_BASE, 'focus-ring', BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

/** A `type="button"` button element; options other than variant, size and className pass to h(). */
export function button(
  label,
  { variant = 'default', size = 'default', className = '', ...rest } = {},
) {
  return h(
    'button',
    { type: 'button', class: buttonClass(variant, size, className), ...rest },
    label,
  );
}

export const FIELD_CLASS =
  'w-full rounded-control border bg-surface px-3 text-sm text-fg transition-colors placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60 h-10 focus-ring';
export const TEXTAREA_CLASS =
  'w-full rounded-control border bg-surface px-3 text-sm text-fg transition-colors placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60 min-h-20 py-2 leading-relaxed focus-ring';

/** A styled input element; `invalid: true` adds a red border and aria-invalid. */
export function input(attributes = {}) {
  const { invalid, className = '', ...rest } = attributes;
  return h('input', {
    class: cn(FIELD_CLASS, invalid ? 'border-negative' : 'border-line-strong', className),
    'aria-invalid': invalid ? 'true' : undefined,
    ...rest,
  });
}

/** A styled textarea element; `invalid: true` adds a red border and aria-invalid. */
export function textarea(attributes = {}) {
  const { invalid, className = '', ...rest } = attributes;
  return h('textarea', {
    class: cn(TEXTAREA_CLASS, invalid ? 'border-negative' : 'border-line-strong', className),
    'aria-invalid': invalid ? 'true' : undefined,
    ...rest,
  });
}

/** A styled select element built from `{ value, label, selected }` option objects. */
export function select(attributes = {}, options = []) {
  const { className = '', ...rest } = attributes;
  return h(
    'select',
    { class: cn(FIELD_CLASS, 'border-line-strong', className), ...rest },
    options.map((option) =>
      h('option', { value: option.value, selected: option.selected }, option.label),
    ),
  );
}

/** A small form label element pointing at the control with id `forId`. */
export function label(text, forId, className = '') {
  return h(
    'label',
    { class: cn('mb-1.5 block text-xs font-medium text-muted', className), for: forId },
    text,
  );
}

/** An alert paragraph with the given id for a field's error, or null when there is no message. */
export function fieldError(id, message) {
  return message
    ? h('p', { id, role: 'alert', class: 'mt-1 text-xs text-negative' }, message)
    : null;
}

/** Card building blocks: card, header, title and content. */
export function card({ className = '', ...rest } = {}, ...children) {
  return h(
    'div',
    { class: cn('rounded-card border border-line bg-surface', className), ...rest },
    ...children,
  );
}
/** Card header row: children spread apart, with a bottom border. */
export function cardHeader(className = '', ...children) {
  return h(
    'div',
    {
      class: cn(
        'flex items-start justify-between gap-4 border-b border-line px-4 py-4 sm:px-5',
        className,
      ),
    },
    ...children,
  );
}
/** Card title as an h3 element. */
export function cardTitle(text, className = '') {
  return h('h3', { class: cn('text-base font-normal text-fg', className) }, text);
}
/** Padded card body. */
export function cardContent(className = '', ...children) {
  return h('div', { class: cn('p-4 sm:p-5', className) }, ...children);
}

const BADGE_TONES = {
  neutral: 'bg-elevated text-muted',
  positive: 'bg-positive-soft text-positive',
  negative: 'bg-negative-soft text-negative',
  caution: 'bg-caution-soft text-caution',
  accent: 'bg-accent-soft text-accent',
};
/** A small monospace pill; tone is neutral, positive, negative, caution or accent. */
export function badge(text, tone = 'neutral', className = '') {
  return h(
    'span',
    {
      class: cn(
        'inline-flex items-center gap-1 rounded-[2px] px-2 py-1 font-mono text-[11px] font-normal',
        BADGE_TONES[tone],
        className,
      ),
    },
    text,
  );
}

/** Dashed placeholder box with a title and optional icon, hint text and action element. */
export function emptyState({ title, hint, iconName, action }) {
  return h(
    'div',
    {
      class:
        'flex flex-col items-center justify-center rounded-card border border-dashed border-line px-6 py-12 text-center',
    },
    iconName ? h('div', { class: 'mb-3 text-subtle' }, icon(iconName, 24)) : null,
    h('h3', { class: 'text-sm font-medium text-fg' }, title),
    hint ? h('p', { class: 'mt-1 max-w-xs text-xs text-muted' }, hint) : null,
    action ? h('div', { class: 'mt-4' }, action) : null,
  );
}

/** Trigger a browser download for generated text. */
export function downloadText(filename, text, type = 'text/plain;charset=utf-8;') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Labelled metric tile. */
export function statCard({ label: labelText, value, hint, tone = 'neutral', iconName }) {
  const valueTone =
    tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-fg';
  return h(
    'div',
    { class: 'rounded-card border border-line bg-surface px-6 py-5' },
    h(
      'div',
      { class: 'flex items-center justify-between' },
      h('span', { class: 'text-xs font-medium text-muted' }, labelText),
      iconName ? h('span', { class: 'text-subtle' }, icon(iconName, 16)) : null,
    ),
    h(
      'div',
      { class: cn('tnum mt-2 text-[29px] font-normal tracking-[-1.1px]', valueTone) },
      value,
    ),
    hint ? h('div', { class: 'mt-1 text-xs text-subtle' }, hint) : null,
  );
}
