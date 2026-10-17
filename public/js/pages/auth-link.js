/**
 * Emailed activation and password-recovery links: post the token once.
 */
import { $ } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';

/** Emailed activation/recovery tokens arrive in the URL fragment and are posted once. */
const root = $('[data-auth-link]');
const status = $('[data-auth-link-status]');
const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '';
history.replaceState(null, '', window.location.pathname);

async function exchange() {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    status.textContent = 'This link is incomplete. Open the latest link from your email.';
    $('[data-auth-link-retry]').hidden = false;
    return;
  }
  try {
    const result = await api('/auth/link', {
      method: 'POST',
      body: { purpose: root.dataset.purpose, token },
    });
    window.location.replace(result.redirect);
  } catch (error) {
    status.textContent = errorMessage(
      error,
      'This link is invalid or has expired. Request a new one.',
    );
    $('[data-auth-link-retry]').hidden = false;
  }
}

void exchange();
