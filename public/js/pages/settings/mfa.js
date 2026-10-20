/** Settings page — MFA settings. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  input,
  label,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { notify } from '../../core/toast.js';
import { cardDescription, errorLine, statusLine } from './shared.js';

const RECOVERY_NOTE =
  'Keep a secure backup in your authenticator app. Blank does not issue recovery codes. If every authenticator is lost, a workspace administrator must arrange identity-verified recovery; password reset alone does not bypass this check.';

function codeField(id, disabled, onInput) {
  const field = input({
    id,
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    pattern: '[0-9]{6}',
    maxlength: '6',
    placeholder: t('6-digit code'),
    required: true,
    disabled,
  });
  field.addEventListener('input', () => {
    field.value = field.value.replace(/\D/g, '').slice(0, 6);
    onInput?.(field.value);
  });
  return h('div', { class: 'space-y-2' }, label(t('Authenticator code'), id), field);
}

/**
 * Mounts the authenticator (MFA) card: lists factors and handles enrolment with QR code,
 * verification, discarding unfinished setup, and removal with a code (/auth/mfa/*).
 */
export function mountMfa() {
  const state = {
    factors: [],
    loading: true,
    busy: false,
    error: '',
    enrollment: null,
    // Administrators adding a first authenticator: { sent, message } while asking for the setup code.
    setupCode: null,
    removing: null,
    backupAccepted: false,
  };
  const root = $('[data-mfa]');

  async function load() {
    state.loading = true;
    state.error = '';
    paint();
    try {
      const result = await api('/auth/mfa/factors');
      if (!Array.isArray(result.all)) throw new Error();
      state.factors = result.all;
    } catch {
      state.error = 'Authenticator settings could not be checked. Try again.';
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function run(action, failure) {
    if (state.busy || state.loading) return;
    state.busy = true;
    state.error = '';
    paint();
    try {
      await action();
    } catch (error) {
      state.error = error?.status === 429 ? errorMessage(error, failure) : failure;
    } finally {
      state.busy = false;
      paint();
    }
  }

  const enroll = (setupCode) =>
    run(async () => {
      try {
        const result = await api('/auth/mfa/enroll', { method: 'POST', body: { setupCode } });
        state.enrollment = { id: result.id, secret: result.secret, qrCode: result.qrCode };
        state.setupCode = null;
        state.backupAccepted = false;
      } catch (error) {
        // An administrator's first authenticator needs a one-time code: ask for it.
        if (error?.payload?.code !== 'admin_setup_code_required') throw error;
        if (state.setupCode) throw new Error();
        state.setupCode = { sent: false, message: '' };
      }
    }, 'Authenticator setup could not start. Check the code or your connection and try again.');

  const sendSetupCode = () =>
    run(async () => {
      try {
        await api('/auth/mfa/admin-code', { method: 'POST', body: {} });
        state.setupCode = { sent: true, message: 'A setup code was sent to your email.' };
      } catch (error) {
        // No email on this server: the message says how to get the code on the server.
        state.setupCode = { sent: false, message: errorMessage(error, 'The code was not sent.') };
      }
    }, 'The code could not be sent. Try again.');

  const discard = (factorId) =>
    run(async () => {
      // Only unverified setup can be discarded without a verification code.
      if (
        factorId !== state.enrollment?.id &&
        !state.factors.some((factor) => factor.id === factorId && factor.status === 'unverified')
      )
        throw new Error();
      await api('/auth/mfa/unenroll', { method: 'POST', body: { factorId } });
      state.enrollment = null;
      await load();
    }, 'Unfinished setup could not be removed. Try again.');

  function paint() {
    const verified = state.factors.filter((factor) => factor.status === 'verified');
    const body = [h('p', { class: 'text-sm leading-relaxed text-muted' }, RECOVERY_NOTE)];
    if (state.loading) body.push(statusLine(t('Checking authenticators…')));
    else if (state.setupCode) {
      const field = input({
        id: 'mfa-setup-code',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        pattern: '[0-9]{8}',
        maxlength: '8',
        placeholder: t('8-digit setup code'),
        required: true,
        disabled: state.busy,
      });
      const form = h(
        'form',
        { class: 'space-y-4' },
        h(
          'p',
          { class: 'text-sm' },
          'Administrators need a one-time setup code to add their first authenticator, so a stolen password alone cannot add one. Get it by email, or on the server with: node scripts/admin-setup-code.js your@email',
        ),
        h('div', { class: 'space-y-2' }, label(t('Setup code'), 'mfa-setup-code'), field),
        state.setupCode.message ? statusLine(state.setupCode.message) : null,
        h(
          'div',
          { class: 'flex flex-wrap gap-3' },
          button(t('Continue'), { type: 'submit', disabled: state.busy }),
          button(state.setupCode.sent ? t('Email a new code') : t('Email me a code'), {
            variant: 'outline',
            disabled: state.busy,
            onclick: () => void sendSetupCode(),
          }),
          button(t('Cancel'), {
            variant: 'outline',
            disabled: state.busy,
            onclick: () => {
              state.setupCode = null;
              paint();
            },
          }),
        ),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (/^\d{8}$/.test(field.value.trim())) void enroll(field.value.trim());
      });
      body.push(form);
    } else if (state.enrollment) {
      let code = '';
      const submit = button(state.busy ? 'Verifying…' : 'Enable authenticator', {
        type: 'submit',
        disabled: true,
      });
      const sync = () =>
        (submit.disabled = state.busy || !state.backupAccepted || !/^\d{6}$/.test(code));
      const backup = h('input', {
        type: 'checkbox',
        class: 'mt-1',
        checked: state.backupAccepted,
        disabled: state.busy,
      });
      backup.addEventListener('change', () => {
        state.backupAccepted = backup.checked;
        sync();
      });
      const secret = input({
        id: 'mfa-setup-key',
        value: state.enrollment.secret,
        readonly: true,
        autocomplete: 'off',
        spellcheck: 'false',
      });
      const form = h(
        'form',
        { class: 'space-y-4' },
        h(
          'p',
          { class: 'text-sm' },
          'Scan this QR code with your authenticator app, or enter the setup key manually. Keep this key private.',
        ),
        h('img', {
          src: state.enrollment.qrCode,
          alt: 'Authenticator enrollment QR code',
          class: 'h-auto w-52 max-w-full rounded-control bg-white p-2',
        }),
        h('div', { class: 'space-y-2' }, label(t('Private setup key'), 'mfa-setup-key'), secret),
        h(
          'label',
          { class: 'flex items-start gap-2 text-sm' },
          backup,
          'I have secured an authenticator backup and understand the recovery limitation.',
        ),
        codeField('mfa-enrollment-code', state.busy, (value) => {
          code = value;
          sync();
        }),
        h(
          'div',
          { class: 'flex flex-wrap gap-3' },
          submit,
          button(t('Cancel setup'), {
            variant: 'outline',
            disabled: state.busy,
            onclick: () => void discard(state.enrollment.id),
          }),
        ),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!state.backupAccepted || !/^\d{6}$/.test(code)) return;
        const factorId = state.enrollment.id;
        void run(async () => {
          await api('/auth/mfa/verify', { method: 'POST', body: { factorId, code } });
          state.enrollment = null;
          await load();
          notify('Authenticator enabled.', 'success');
        }, 'The code could not be verified. Use the latest code from your authenticator and try again.');
      });
      body.push(form);
    } else if (state.removing) {
      let code = '';
      const submit = button(state.busy ? 'Removing…' : 'Verify and remove', {
        type: 'submit',
        disabled: true,
      });
      const form = h(
        'form',
        { class: 'space-y-4' },
        h(
          'p',
          { class: 'text-sm' },
          `Enter a current code from this authenticator to remove it.${verified.length === 1 ? ' Removing your last authenticator turns off the extra sign-in check.' : ''}`,
        ),
        codeField('mfa-removal-code', state.busy, (value) => {
          code = value;
          submit.disabled = state.busy || !/^\d{6}$/.test(code);
        }),
        h(
          'div',
          { class: 'flex flex-wrap gap-3' },
          submit,
          button(t('Keep authenticator'), {
            variant: 'outline',
            disabled: state.busy,
            onclick: () => {
              state.removing = null;
              paint();
            },
          }),
        ),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!/^\d{6}$/.test(code)) return;
        const factorId = state.removing;
        void run(async () => {
          if (
            !state.factors.some(
              (factor) =>
                factor.id === factorId &&
                factor.status === 'verified' &&
                factor.factor_type === 'totp',
            )
          )
            throw new Error();
          await api('/auth/mfa/unenroll', { method: 'POST', body: { factorId, code } });
          state.removing = null;
          await load();
        }, 'Authenticator removal failed. Enter a new code and try again.');
      });
      body.push(form);
    } else {
      body.push(
        state.factors.map((factor, index) =>
          h(
            'div',
            {
              class:
                'flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3',
            },
            h(
              'div',
              { class: 'min-w-0 break-words text-sm' },
              h('p', {}, factor.friendly_name || `Authenticator ${index + 1}`),
              h(
                'p',
                { class: 'text-xs text-muted' },
                factor.status === 'verified' ? 'Enabled' : 'Unfinished setup',
              ),
            ),
            factor.status === 'unverified'
              ? button(t('Discard setup'), {
                  variant: 'outline',
                  disabled: state.busy,
                  onclick: () => void discard(factor.id),
                })
              : factor.factor_type === 'totp'
                ? button(t('Remove authenticator'), {
                    variant: 'outline',
                    disabled: state.busy,
                    onclick: () => {
                      state.removing = factor.id;
                      paint();
                    },
                  })
                : null,
          ),
        ),
        button(state.busy ? 'Starting…' : 'Add authenticator', {
          disabled: state.busy,
          onclick: () => void enroll(),
        }),
      );
    }
    if (state.error) {
      body.push(
        h(
          'div',
          { class: 'space-y-2' },
          errorLine(state.error),
          button(t('Retry check'), {
            variant: 'outline',
            disabled: state.busy || state.loading,
            onclick: () => void load(),
          }),
        ),
      );
    }
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Authenticator security')),
            cardDescription(
              verified.length
                ? 'Authenticator verification is required for this account.'
                : 'Add an optional authenticator app to protect your workspace.',
            ),
          ),
        ),
        cardContent('space-y-5', body),
      ),
    );
  }
  void load();
}
