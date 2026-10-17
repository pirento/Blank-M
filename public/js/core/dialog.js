/**
 * Accessible dialogs, sheets and modals with focus trapping (one shared stack).
 */
import { h, icon, cn } from './dom.js';

/**
 * One keyboard/focus implementation for dialogs, the menu and search: focus
 * moves inside, Tab is trapped, Escape and backdrop clicks close, the page
 * behind becomes inert, and focus returns to the opener when closed.
 */
const stack = [];
const previousInert = new Map();
let previousBodyOverflow = '';

function updateBackground() {
  const top = stack.at(-1)?.overlay;
  if (!top) {
    for (const [element, wasInert] of previousInert) element.toggleAttribute('inert', wasInert);
    previousInert.clear();
    document.body.style.overflow = previousBodyOverflow;
  } else {
    for (const element of document.body.children) {
      if (!previousInert.has(element)) previousInert.set(element, element.hasAttribute('inert'));
      element.toggleAttribute('inert', element !== top);
    }
  }
  document.dispatchEvent(new CustomEvent('blank:dialogs-changed'));
}

function focusable(container) {
  return [
    ...container.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
    ),
  ].filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled, input[type="hidden"]')) return false;
    let current = element;
    while (current && current !== container) {
      if (current.matches('[hidden], [inert]')) return false;
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      current = current.parentElement;
    }
    return true;
  });
}

/** The topmost open dialog element, or null when none is open. */
export function activeDialog() {
  return stack.at(-1)?.dialog ?? null;
}

/**
 * Open a dialog. Returns `{ dialog, close }`. `content` is a Node or a function
 * receiving `close` and returning a Node.
 */
export function openDialog({
  label,
  content,
  className = '',
  overlayClassName = '',
  describedBy,
  id,
  initialFocus,
  onClose,
}) {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = h('div', {
    id,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': label,
    'aria-describedby': describedBy,
    tabindex: '-1',
    class: cn('w-full outline-none', className),
  });
  const overlay = h(
    'div',
    {
      class: cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm',
        overlayClassName,
      ),
    },
    dialog,
  );
  let closed = false;
  let backdropPress = false;
  const entry = { overlay, dialog };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusin', onFocus);
    const wasTop = stack.at(-1) === entry;
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    overlay.remove();
    updateBackground();
    if (wasTop && returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus();
    onClose?.();
  };
  const body = typeof content === 'function' ? content(close) : content;
  if (body) dialog.append(body);
  overlay.addEventListener('pointerdown', (event) => {
    backdropPress = event.target === overlay;
  });
  overlay.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target === overlay && backdropPress) close();
    backdropPress = false;
  });
  const onKeyDown = (event) => {
    if (stack.at(-1) !== entry || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const elements = focusable(dialog);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !elements.includes(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !elements.includes(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  const onFocus = (event) => {
    if (stack.at(-1) === entry && !dialog.contains(event.target))
      (focusable(dialog)[0] ?? dialog).focus();
  };
  if (stack.length === 0) previousBodyOverflow = document.body.style.overflow;
  document.body.append(overlay);
  stack.push(entry);
  document.body.style.overflow = 'hidden';
  updateBackground();
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocus);
  const target =
    typeof initialFocus === 'string' ? dialog.querySelector(initialFocus) : initialFocus;
  (target ?? focusable(dialog)[0] ?? dialog).focus();
  return { dialog, close };
}

let modalCount = 0;
/** Titled modal with a close button. */
export function openModal({ title, description, content, wide = false, onClose }) {
  const descriptionId = `modal-description-${++modalCount}`;
  return openDialog({
    label: title,
    describedBy: description ? descriptionId : undefined,
    onClose,
    className: cn(
      'flex max-h-[calc(100dvh-2rem)] flex-col rounded-card border border-line bg-surface shadow-xl',
      wide ? 'max-w-2xl' : 'max-w-md',
    ),
    content: (close) =>
      h(
        'div',
        { class: 'contents' },
        h(
          'div',
          {
            class: 'flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4',
          },
          h(
            'div',
            {},
            h('h2', { class: 'text-base font-semibold text-fg' }, title),
            description
              ? h('p', { id: descriptionId, class: 'mt-1 text-sm text-muted' }, description)
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              onclick: close,
              'aria-label': `Close ${title}`,
              class:
                'focus-ring -mr-2 -mt-1 rounded-control p-2 text-muted hover:bg-elevated hover:text-fg',
            },
            icon('x', 18),
          ),
        ),
        h(
          'div',
          { class: 'min-h-0 overflow-y-auto overscroll-contain p-5' },
          typeof content === 'function' ? content(close) : content,
        ),
      ),
  });
}

/** Promise-based confirmation using the shared modal. */
export function confirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => {
      if (settled) return;
      settled = true;
      close?.();
      resolve(value);
    };
    openModal({
      title,
      description,
      onClose: () => finish(false),
      content: (close) =>
        h(
          'div',
          { class: 'flex flex-wrap justify-end gap-2' },
          h(
            'button',
            {
              type: 'button',
              class:
                'inline-flex min-h-10 items-center justify-center rounded-control border border-line-strong bg-surface px-4 text-sm text-fg hover:bg-elevated focus-ring',
              onclick: () => finish(false, close),
            },
            'Cancel',
          ),
          h(
            'button',
            {
              type: 'button',
              class: cn(
                'inline-flex min-h-10 items-center justify-center rounded-control px-4 text-sm focus-ring',
                destructive
                  ? 'bg-negative text-white hover:opacity-90'
                  : 'bg-accent text-accent-fg hover:bg-accent-hover',
              ),
              onclick: () => finish(true, close),
            },
            confirmLabel,
          ),
        ),
    });
  });
}
