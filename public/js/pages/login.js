/**
 * Login page: password or username sign-in and the forgot-password form.
 */
import { $, icon, render } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;
const root = $('[data-login]');
const form = $('[data-login-form]');
const mode = root?.dataset.mode ?? 'signin';
const changesPassword = mode === 'activate' || mode === 'recover';

const errorBox = $('[data-login-error]');
const successBox = $('[data-login-success]');
let submitting = false;

function show(element, message) {
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function fieldError(id, message) {
  const element = document.getElementById(`${id}-error`);
  const field = document.getElementById(id);
  show(element, message);
  if (field) {
    field.classList.toggle('border-negative', Boolean(message));
    field.classList.toggle('border-line-strong', !message);
    if (message) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', `${id}-error`);
    } else {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
    }
  }
}

$('[data-toggle-password]')?.addEventListener('click', (event) => {
  const button = event.currentTarget;
  const field = $('#password');
  const visible = field.type === 'password';
  field.type = visible ? 'text' : 'password';
  button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  render(button, icon(visible ? 'eye-off' : 'eye', 16));
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;
  show(errorBox, '');
  show(successBox, '');
  const identifier = $('#email')?.value ?? '';
  const password = $('#password')?.value ?? '';
  let invalid = false;
  if (!changesPassword) {
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim());
    const validUsername = USERNAME_PATTERN.test(identifier.trim().toLowerCase());
    const message =
      !validEmail && (mode !== 'signin' || !validUsername)
        ? mode === 'signin'
          ? 'Enter your username or invited email.'
          : 'Enter a valid email address.'
        : '';
    fieldError('email', message);
    invalid ||= Boolean(message);
  }
  if (mode !== 'reset') {
    const message =
      password.length < MIN_PASSWORD_LENGTH
        ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
        : '';
    fieldError('password', message);
    invalid ||= Boolean(message);
  }
  if (invalid) return;

  submitting = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.prepend(icon('loader-2', 14, 'mr-2 animate-spin'));
  try {
    if (mode === 'signin') {
      await api('/auth/login', { method: 'POST', body: { identifier, password } });
      // A full navigation re-reads membership and authenticator state on the server.
      window.location.assign('/dashboard');
      return;
    }
    if (mode === 'reset') {
      await api('/auth/recover', { method: 'POST', body: { email: identifier.trim() } });
      show(successBox, 'Password reset instructions have been sent if the address is eligible.');
    } else {
      const result = await api('/auth/password', { method: 'POST', body: { password } });
      $('#password').value = '';
      window.location.replace(result?.redirect || '/dashboard');
      return;
    }
  } catch (error) {
    show(
      errorBox,
      errorMessage(
        error,
        'The request could not be completed. Check your connection and try again.',
      ),
    );
  } finally {
    submitting = false;
    submit.disabled = false;
    submit.querySelector('.lucide-loader-2')?.remove();
  }
});
