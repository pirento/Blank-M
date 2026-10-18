/**
 * Admin sign-in page: posts to /auth/admin/login, which accepts administrator
 * accounts only, then opens the panel (the server asks for the authenticator
 * code there when one is set up).
 */
import { $ } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';

const form = $('[data-admin-login-form]');
const errorBox = $('[data-admin-login-error]');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('[type=submit]');
  const identifier = $('#admin-email').value.trim();
  const password = $('#admin-password').value;
  errorBox.hidden = true;
  if (!identifier || !password) {
    errorBox.textContent = 'Enter your email (or username) and password.';
    errorBox.hidden = false;
    return;
  }
  submit.disabled = true;
  try {
    await api('/auth/admin/login', { method: 'POST', body: { identifier, password } });
    window.location.assign('/admin');
  } catch (error) {
    errorBox.textContent = errorMessage(error, 'Sign-in failed. Try again.');
    errorBox.hidden = false;
    submit.disabled = false;
  }
});
