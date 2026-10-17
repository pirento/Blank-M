/**
 * Accept a private invitation link: choose a password and activate the account.
 */
import { $ } from '../core/dom.js';

/**
 * The single-use token stays in page memory only: it is read from the URL
 * fragment (never sent as a query string or referrer) and removed immediately.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
let token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '';
if (window.location.hash) history.replaceState(null, '', '/invite');

const formWrap = $('[data-invitation-form-wrap]');
const form = $('[data-invitation-form]');
const passwordField = $('#invitation-password');
const errorBox = $('#invitation-error');
const submit = form.querySelector('[type="submit"]');
let pending = false;
let requiresReview = false;

function setError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
  passwordField.toggleAttribute('aria-invalid', Boolean(message));
  if (message) passwordField.setAttribute('aria-describedby', 'invitation-error');
}

function paint() {
  const valid = TOKEN_RE.test(token);
  $('[data-invitation-missing]').hidden = valid || !$('[data-invitation-accepted]').hidden;
  formWrap.hidden = !valid;
}

async function accept(password) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    let response;
    try {
      response = await fetch('/api/invitations/accept', {
        method: 'POST',
        credentials: 'omit',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
    } catch {
      return {
        error:
          'Activation could not be confirmed. Ask your administrator to review this invitation before trying again.',
        requiresReview: true,
      };
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const known = data && typeof data.error === 'string';
      // Only explicit validation/quota responses are safe to correct and retry.
      return {
        error: known
          ? data.error
          : 'Activation could not be confirmed. Ask your administrator to review this invitation.',
        requiresReview:
          !known || ![400, 403, 409, 429].includes(response.status) || data.requiresReview === true,
      };
    }
    if (data?.accepted !== true || typeof data.email !== 'string') {
      return {
        error:
          'Activation could not be confirmed. Ask your administrator to review this invitation.',
        requiresReview: true,
      };
    }
    return { email: data.email };
  } finally {
    clearTimeout(timeout);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pending || requiresReview || !TOKEN_RE.test(token)) return;
  const password = passwordField.value;
  if (password.length < 12 || password.length > 128) {
    setError('Use a password of 12 to 128 characters.');
    return;
  }
  pending = true;
  submit.disabled = true;
  passwordField.disabled = true;
  submit.textContent = 'Creating membership…';
  setError('');
  const result = await accept(password);
  pending = false;
  passwordField.value = '';
  if (result.email) {
    token = '';
    $('[data-invitation-title]').textContent = 'Your membership is ready.';
    $('[data-accepted-email]').textContent = result.email;
    $('[data-invitation-accepted]').hidden = false;
    paint();
    return;
  }
  setError(result.error);
  requiresReview = Boolean(result.requiresReview);
  $('[data-invitation-review]').hidden = !requiresReview;
  submit.disabled = requiresReview;
  passwordField.disabled = requiresReview;
  submit.textContent = 'Create my membership';
});

paint();
