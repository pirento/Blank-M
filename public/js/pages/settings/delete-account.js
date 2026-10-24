/** Settings page — delete the account for good. */
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
import { notifyAfterReload } from '../../core/toast.js';
import { cardDescription, data, errorLine } from './shared.js';

/**
 * Mounts the "Delete account" card: the member types their email (and current password, if the
 * account has one) and POST /api/account/delete removes the account and all its data.
 */
export function mountDeleteAccount() {
  const root = $('[data-delete-account]');
  if (!root || !data?.email) return;
  const confirm = input({
    id: 'delete-confirm',
    type: 'email',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
  });
  const password = data.hasPassword
    ? input({ id: 'delete-password', type: 'password', autocomplete: 'current-password' })
    : null;
  const status = h('div');
  const submit = button(t('Delete my account'), {
    variant: 'destructive',
    onclick: async () => {
      submit.disabled = true;
      render(status);
      try {
        await api('/api/account/delete', {
          method: 'POST',
          body: { confirm: confirm.value, currentPassword: password?.value },
        });
        notifyAfterReload(t('Your account and its data were deleted. Goodbye.'), 'success');
        window.location.assign('/');
      } catch (error) {
        render(status, errorLine(errorMessage(error, t('The account could not be deleted.'))));
        submit.disabled = false;
      }
    },
  });
  render(
    root,
    card(
      { className: 'border-negative' },
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Delete account')),
          cardDescription(
            t(
              'Deletes your account, journal, files, broker links and AI data for good. This cannot be undone. Payment records are kept as the law requires.',
            ),
          ),
        ),
      ),
      cardContent(
        'space-y-3',
        h(
          'p',
          { class: 'text-sm' },
          t('Take a backup first if you want to keep your records.'),
          ' ',
          h(
            'a',
            { href: '/api/account/export', download: '', class: 'underline' },
            t('Download a backup now'),
          ),
        ),
        label(
          t('Type your email address to confirm: {email}', { email: data.email }),
          'delete-confirm',
        ),
        confirm,
        password ? label(t('Current password'), 'delete-password') : null,
        password,
        password
          ? null
          : h(
              'p',
              { class: 'text-xs text-muted' },
              t('You sign in with Google: sign in with Google again just before deleting.'),
            ),
        submit,
        status,
      ),
    ),
  );
}
