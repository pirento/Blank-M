/**
 * Admin panel shell: sign-out button. Every admin page loads this before its own module.
 */
import { $ } from '../core/dom.js';
import { api } from '../core/api.js';

$('[data-admin-sign-out]')?.addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } catch {
    // The session lives on the server; going to the sign-in page shows the real state.
  }
  window.location.assign('/admin/login');
});
