/**
 * Toast notifications (instead of window.alert), including ones shown after a reload.
 */
import { h, icon, cn } from './dom.js';
import { activeDialog } from './dialog.js';

/**
 * Non-blocking notifications in place of window.alert(). Errors stay until
 * dismissed, so keyboard users can reach them; other tones dismiss after 5s.
 */
const DISMISS_AFTER_MS = 5000;
let region = null;

function ensureRegion() {
  // Created once and moved between the page and dialogs, so toasts survive a dialog closing.
  if (!region) {
    region = h('div', {
      class:
        'pointer-events-none fixed right-4 z-[100] flex max-h-[50dvh] w-[calc(100%-2rem)] max-w-sm flex-col gap-2 overflow-y-auto',
      role: 'region',
      'aria-label': 'Notifications',
      // A live region that already exists is announced reliably when a toast is added to it.
      'aria-live': 'polite',
    });
    document.body.append(region);
  }
  // Interactive notifications stay inside the top dialog's focus boundary.
  const dialog = activeDialog();
  const host = dialog ?? document.body;
  if (region.parentElement !== host) host.append(region);
  region.style.bottom = dialog ? '1rem' : 'var(--workspace-toast-bottom, 1rem)';
  return region;
}

document.addEventListener('blank:dialogs-changed', () => {
  if (region?.childElementCount) ensureRegion();
});
// Exists before the first toast, so screen readers announce it.
if (document.body) ensureRegion();
else document.addEventListener('DOMContentLoaded', ensureRegion, { once: true });

/** Show a toast; tone is 'info', 'success' or 'error'. Errors stay until dismissed, others go after 5s. */
export function notify(message, tone = 'info') {
  const container = ensureRegion();
  const item = h(
    'div',
    {
      role: tone === 'error' ? 'alert' : 'status',
      'aria-atomic': 'true',
      class: cn(
        'pointer-events-auto flex shrink-0 items-start gap-3 rounded-card border p-4 shadow-lg backdrop-blur',
        tone === 'error' && 'border-negative bg-negative-soft text-negative',
        tone === 'success' && 'border-positive bg-positive-soft text-positive',
        tone === 'info' && 'border-line bg-surface text-fg',
      ),
    },
    icon(
      tone === 'error' ? 'alert-circle' : tone === 'success' ? 'check-circle-2' : 'info',
      16,
      'mt-0.5 shrink-0',
    ),
    h('p', { class: 'flex-1 text-sm leading-snug' }, message),
  );
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    item.remove();
  };
  item.append(
    h(
      'button',
      {
        type: 'button',
        'aria-label': 'Dismiss notification',
        class: 'focus-ring shrink-0 text-muted transition-opacity hover:opacity-100',
        onclick: (event) => {
          event.currentTarget.closest('[role="dialog"]')?.focus();
          dismiss();
        },
      },
      icon('x', 14),
    ),
  );
  container.append(item);
  if (tone !== 'error') timer = setTimeout(dismiss, DISMISS_AFTER_MS);
}

/** Show an error toast with the error's message, or fallback when it has none. */
export function notifyError(error, fallback = 'Something went wrong. Please try again.') {
  notify(error instanceof Error && error.message ? error.message : fallback, 'error');
}

const FLASH_KEY = 'blank_flash';

/** Show a notification after the next page load (used after reloading fresh server data). */
export function notifyAfterReload(message, tone = 'info') {
  try {
    window.sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, tone }));
  } catch {
    // The change is saved; only the confirmation message is lost.
  }
}

/** Reload the page and show the message as a toast once it has loaded. */
export function reloadWith(message, tone = 'success') {
  notifyAfterReload(message, tone);
  window.location.reload();
}

try {
  const raw = window.sessionStorage.getItem(FLASH_KEY);
  if (raw) {
    window.sessionStorage.removeItem(FLASH_KEY);
    const { message, tone } = JSON.parse(raw);
    if (typeof message === 'string') queueMicrotask(() => notify(message, tone));
  }
} catch {
  // Unavailable session storage only drops the confirmation.
}
