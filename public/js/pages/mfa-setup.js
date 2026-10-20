/**
 * "Add an authenticator" screen for administrators without one: the same card as
 * Settings → Authenticator; once the authenticator is verified, continue to the admin panel.
 */
import { $ } from '../core/dom.js';
import { api } from '../core/api.js';
import { mountMfa } from './settings/mfa.js';

mountMfa({ onEnabled: () => window.location.assign('/admin') });
$('[data-sign-out]').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } finally {
    window.location.assign('/admin/login');
  }
});
