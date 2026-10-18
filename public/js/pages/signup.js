/**
 * Sign-up page: sends the email to /auth/signup; the server emails an
 * activation link. The answer is the same whether or not the address is known.
 */
import { $ } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';

const form = $('[data-signup-form]');
const errorBox = $('[data-signup-error]');
const successBox = $('[data-signup-success]');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  successBox.hidden = true;
  const email = $('#signup-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errorBox.textContent = 'Enter a valid email address.';
    errorBox.hidden = false;
    return;
  }
  if (!$('[data-signup-agree]').checked) {
    errorBox.textContent = 'Tick the box to continue.';
    errorBox.hidden = false;
    return;
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    await api('/auth/signup', { method: 'POST', body: { email } });
    successBox.textContent = `Check ${email} for a link to confirm your account (also look in spam).`;
    successBox.hidden = false;
    form.reset();
  } catch (error) {
    errorBox.textContent = errorMessage(error, 'Sign-up failed. Try again.');
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
  }
});
