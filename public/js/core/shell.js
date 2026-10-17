/**
 * Workspace shell behaviour shared by every member page: IST clock, menu sheet,
 * theme toggle and sign-out; boots the command palette and shortcuts
 * (core/command-palette.js).
 */
import { $, $$, icon } from './dom.js';
import { openDialog } from './dialog.js';
import { currentTheme, toggleTheme } from './theme.js';
import { bindShortcuts, openCommandPalette } from './command-palette.js';
import { watchStackTables } from './stack-tables.js';
import { api, errorMessage } from './api.js';
import { notify } from './toast.js';
import { describeMarketStatus, getMarketStatus } from '../../../shared/market.js';

/* ------------------------------------ clock ----------------------------------- */
const MARKET_LABELS = {
  open: 'open',
  'closed-hours': 'closed',
  'closed-weekend': 'weekend',
  'closed-holiday': 'holiday',
};

function startClock() {
  const clock = $('[data-ist-clock]');
  const market = $('[data-market-status] b');
  if (!clock && !market) return;
  const update = () => {
    const now = new Date();
    if (clock) {
      clock.dateTime = now.toISOString();
      clock.textContent = `${now.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
      })} IST`;
    }
    if (market) {
      const status = getMarketStatus(now);
      market.textContent = MARKET_LABELS[status] ?? 'unverified';
      market.parentElement.dataset.state = status === 'open' ? 'open' : 'closed';
      market.parentElement.setAttribute('aria-label', describeMarketStatus(status));
    }
  };
  update();
  setInterval(update, 30_000);
}

/* ---------------------------------- sign out ---------------------------------- */
/** Ends the server session, then goes to the login page (also when the request fails). */
export async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } catch {
    // The session cookie is server-side; reloading reflects the true state.
  }
  window.location.assign('/login');
}

function bindSignOut(root = document) {
  for (const button of $$('[data-sign-out]', root)) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await signOut();
      } catch (error) {
        button.disabled = false;
        notify(errorMessage(error, 'Could not sign out. Please try again.'), 'error');
      }
    });
  }
}

/* ------------------------------------ menu ------------------------------------ */
function openMenu(trigger) {
  const template = document.getElementById('workspace-menu-template');
  if (!template) return;
  trigger.setAttribute('aria-expanded', 'true');
  const { dialog, close } = openDialog({
    label: 'Menu',
    id: 'workspace-menu-dialog',
    overlayClassName: 'p-0',
    className: 'workspace-menu-panel',
    content: template.content.cloneNode(true),
    onClose: () => trigger.setAttribute('aria-expanded', 'false'),
  });
  $('[data-menu-close]', dialog)?.addEventListener('click', close);
  $('[data-menu-search]', dialog)?.addEventListener('click', () => {
    close();
    openCommandPalette();
  });
  for (const toggle of $$('[data-theme-toggle]', dialog)) bindThemeToggle(toggle);
  for (const link of $$('a', dialog)) link.addEventListener('click', () => close());
  bindSignOut(dialog);
}

function bindThemeToggle(button) {
  const paint = () => {
    const dark = currentTheme() === 'dark';
    button.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
    button.replaceChildren(icon(dark ? 'sun' : 'moon', 17));
  };
  paint();
  button.addEventListener('click', () => {
    toggleTheme();
    paint();
  });
}

/* ------------------------------------ boot ------------------------------------ */
startClock();
bindShortcuts();
watchStackTables();
bindSignOut();
for (const toggle of $$('[data-theme-toggle]')) bindThemeToggle(toggle);
$('[data-open-menu]')?.addEventListener('click', (event) => openMenu(event.currentTarget));
for (const button of $$('[data-open-palette]'))
  button.addEventListener('click', openCommandPalette);
// Keep the current section in view in the scrollable dock.
$('.workspace-dock-link[aria-current="page"]')?.scrollIntoView?.({
  block: 'nearest',
  inline: 'nearest',
});
document.querySelector('#main-content')?.focus?.({ preventScroll: true });

// Installable app and push notifications (see /sw.js). Registration failure is harmless.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
