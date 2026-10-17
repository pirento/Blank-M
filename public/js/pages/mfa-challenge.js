/**
 * Authenticator challenge after sign-in (verifies a 6-digit TOTP code).
 */
import { $, h, render } from '../core/dom.js';
import { api } from '../core/api.js';

const form = $('[data-mfa-form]');
const codeInput = $('#mfa-signin-code');
const submit = form.querySelector('[type="submit"]');
const picker = $('[data-factor-picker]');
const factorSelect = $('#mfa-factor');
const errorBox = $('[data-mfa-error]');
let busy = false;

function setError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

async function load() {
  $('[data-mfa-loading]').hidden = false;
  form.hidden = true;
  $('[data-mfa-none]').hidden = true;
  setError('');
  try {
    const { all } = await api('/auth/mfa/factors');
    const verified = all.filter(
      (factor) => factor.factor_type === 'totp' && factor.status === 'verified',
    );
    render(
      factorSelect,
      ...verified.map((factor, index) =>
        h('option', { value: factor.id }, factor.friendly_name || `Authenticator ${index + 1}`),
      ),
    );
    picker.hidden = verified.length <= 1;
    form.hidden = verified.length === 0;
    $('[data-mfa-none]').hidden = verified.length > 0;
  } catch {
    setError('Authenticator settings could not be checked. Try again.');
  } finally {
    $('[data-mfa-loading]').hidden = true;
  }
}

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
  submit.disabled = busy || !/^\d{6}$/.test(codeInput.value);
});
factorSelect.addEventListener('change', () => {
  codeInput.value = '';
  submit.disabled = true;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = codeInput.value;
  if (busy || !/^\d{6}$/.test(code) || !factorSelect.value) return;
  busy = true;
  submit.disabled = true;
  submit.textContent = 'Verifying…';
  codeInput.value = '';
  setError('');
  try {
    await api('/auth/mfa/verify', { method: 'POST', body: { factorId: factorSelect.value, code } });
    window.location.reload();
  } catch {
    setError(
      'The code could not be verified. Use the latest code from your authenticator and try again.',
    );
    busy = false;
    submit.textContent = 'Verify and continue';
  }
});

$('[data-mfa-retry]').addEventListener('click', () => void load());
$('[data-sign-out]').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } finally {
    window.location.assign('/login');
  }
});
void load();
