/**
 * Home page "Request access" form: sends the request to /auth/request-access. The answer is the
 * same for every address; an administrator approves it and the visitor gets an email.
 */
import { $ } from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
// Shows a message left by the previous page (the goodbye after deleting an account).
import '../core/toast.js';

const form = $('[data-access-request]');
const errorBox = $('[data-access-error]');
const successBox = $('[data-access-success]');

function fail(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  successBox.hidden = true;
  const fields = Object.fromEntries(new FormData(form));
  if (fields.name.trim().length < 2) return fail('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim())) {
    return fail('Enter a valid email address.');
  }
  if (!fields.agree) return fail('Tick the box to continue.');
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    await api('/auth/request-access', {
      method: 'POST',
      body: {
        name: fields.name,
        email: fields.email,
        phone: fields.phone,
        message: fields.message,
        website: fields.website,
      },
    });
    successBox.textContent = `Thank you. We emailed ${fields.email.trim()} to confirm we have your request, and we will write again once it is reviewed.`;
    successBox.hidden = false;
    form.reset();
  } catch (error) {
    fail(errorMessage(error, 'The request could not be sent. Try again.'));
  } finally {
    submit.disabled = false;
  }
});
