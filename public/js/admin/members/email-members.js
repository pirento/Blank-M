/**
 * Members invited by email: loading the list, resending, revoking or restoring an
 * invitation, creating one-hour password reset links, and each member row.
 */
import { h, icon, button, input, label, badge } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { openModal } from '../../core/dialog.js';
import { notify, notifyError } from '../../core/toast.js';
import { paint } from './paint.js';
import { ist, readableDate, state } from './shared.js';

/** Reloads workspace users from /api/admin/users and repaints. */
export async function refresh() {
  state.loading = true;
  state.loadError = null;
  paint();
  try {
    state.users = (await api('/api/admin/users')).users;
  } catch (error) {
    state.loadError =
      'The latest membership records could not be loaded. Retry Refresh; previously loaded records may be out of date.';
    notifyError(error, 'Could not load workspace users.');
  } finally {
    state.loading = false;
    paint();
  }
}

/** Runs `action` with `state.busy` set to `key`, ignoring the call while another action is busy. */
export async function withBusy(key, action) {
  if (state.busy) return;
  state.busy = key;
  paint();
  try {
    await action();
  } finally {
    state.busy = null;
    paint();
  }
}

const resend = (user) =>
  withBusy(user.email, async () => {
    try {
      await api('/api/admin/users/resend', { method: 'POST', body: { email: user.email } });
      notify('Invitation request accepted. Email delivery is not confirmed.', 'success');
      await refresh();
    } catch (error) {
      notifyError(error, 'Could not request another invitation.');
    }
  });

/**
 * Revokes a user's workspace access and reloads users. If the request fails after the
 * server confirmed the revocation, the row is marked revoked before reloading.
 */
export const revoke = (user) =>
  withBusy(user.email, async () => {
    try {
      await api('/api/admin/users/revoke', {
        method: 'POST',
        body: { email: user.email, userId: user.userId },
      });
      notify('Workspace access revoked.', 'success');
      await refresh();
    } catch (error) {
      notifyError(error, 'Could not revoke access.');
      if (error?.payload?.workspaceAccessRevoked) {
        // The server confirmed the revocation even if a later step failed.
        state.users = state.users.map((entry) =>
          entry.email === user.email
            ? {
                ...entry,
                status: 'revoked',
                accessStatus: entry.accessStatus === 'not_created' ? 'not_created' : 'revoked',
                authBanPending: error.payload.authBanStatus === 'pending',
              }
            : entry,
        );
        await refresh();
      }
    }
  });

/** Show a one-time password reset link; it is never stored in the browser. */
const createResetLink = (user) =>
  withBusy(user.email, async () => {
    let result;
    try {
      result = await api('/api/admin/users/reset-link', {
        method: 'POST',
        body: { email: user.email },
      });
    } catch (error) {
      notifyError(error, 'Could not create a reset link.');
      return;
    }
    openModal({
      title: 'Password reset link',
      description: user.email,
      content: (close) => {
        const link = input({ id: 'reset-link', value: result.url, readonly: true });
        link.addEventListener('focus', () => link.select());
        const status = h('p', { role: 'status', class: 'text-xs text-muted' });
        return h(
          'div',
          { class: 'space-y-3' },
          h(
            'p',
            { class: 'text-sm text-muted' },
            `No email was sent. Share this single-use link only with ${user.email}. It expires ${ist(result.expiresAt)} IST and replaces any earlier reset link.`,
          ),
          label('Reset link', link.id),
          link,
          h(
            'div',
            { class: 'flex flex-wrap justify-end gap-2' },
            button('Copy link', {
              variant: 'outline',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(result.url);
                  status.textContent = 'Copied.';
                } catch {
                  status.textContent =
                    'Clipboard access is unavailable. Select and copy the link field.';
                }
              },
            }),
            button('Done', { onclick: close }),
          ),
          status,
          h(
            'p',
            { class: 'text-xs text-muted' },
            'This link cannot be retrieved again after you close this window.',
          ),
        );
      },
    });
  });

function requestRevoke(user) {
  if (state.busy) return;
  const title =
    user.status === 'active'
      ? 'Suspend member access?'
      : user.status === 'revoked'
        ? 'Retry access revocation?'
        : 'Revoke invitation?';
  openModal({
    title,
    description: `Review the access change for ${user.email}.`,
    content: (close) =>
      h(
        'div',
        {},
        h(
          'p',
          { class: 'text-sm leading-6 text-muted' },
          `${user.status === 'invited' ? 'This invitation will be revoked and any existing workspace access for this identity will be disabled.' : 'This member will lose workspace access. The authentication ban will also be requested; any incomplete ban remains available to retry.'} Existing broker positions are unchanged.`,
        ),
        h(
          'div',
          { class: 'mt-6 flex flex-wrap justify-end gap-3' },
          button('Cancel', { variant: 'outline', onclick: close }),
          button('Confirm access change', {
            variant: 'destructive',
            disabled: Boolean(state.busy),
            onclick: () => {
              close();
              void revoke(user);
            },
          }),
        ),
      ),
  });
}

function requestRestore(user) {
  if (state.busy) return;
  openModal({
    title: 'Restore access?',
    description: `Give ${user.email} access again.`,
    content: (close) =>
      h(
        'div',
        {},
        h(
          'p',
          { class: 'text-sm leading-6 text-muted' },
          'They can sign in again (an invitation not yet activated can be resent). What the suspension removed does not come back: broker connections, push devices and the Telegram link must be set up again, and a cancelled Premium subscription stays cancelled.',
        ),
        h(
          'div',
          { class: 'mt-6 flex flex-wrap justify-end gap-3' },
          button('Cancel', { variant: 'outline', onclick: close }),
          button('Restore access', {
            disabled: Boolean(state.busy),
            onclick: () => {
              close();
              void withBusy(user.email, async () => {
                try {
                  await api('/api/admin/users/restore', {
                    method: 'POST',
                    body: { email: user.email, userId: user.userId },
                  });
                  notify('Access restored.', 'success');
                  await refresh();
                } catch (error) {
                  notifyError(error, 'Could not restore access.');
                }
              });
            },
          }),
        ),
      ),
  });
}

/** Builds a member or invitation row: status badges and warnings, plus reset-link, resend, revoke and restore buttons. */
export function userRow(user) {
  const busy = Boolean(state.busy);
  const tone =
    user.status === 'active' ? 'positive' : user.status === 'revoked' ? 'negative' : 'caution';
  const created = user.accessStatus !== 'not_created';
  const canRevoke =
    user.status !== 'revoked' || user.authBanPending || user.accessStatus === 'active';
  return h(
    'div',
    { class: 'admin-reference-row' },
    h(
      'div',
      { class: 'min-w-0' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('p', { class: 'break-all' }, user.email),
        badge(`Invitation: ${user.status}`, tone),
        created && user.role === 'admin' ? badge([icon('shield', 11), 'admin'], 'accent') : null,
      ),
      h(
        'p',
        { class: 'mt-1 text-xs text-muted' },
        `Workspace access: ${created ? user.accessStatus : 'not created'} · ${created ? 'Workspace role' : 'Invited role'}: ${created ? user.role : user.invitationRole}`,
      ),
      created && user.invitationRole !== user.role
        ? h('p', { class: 'mt-1 text-xs text-subtle' }, `Invited role: ${user.invitationRole}`)
        : null,
      user.status === 'revoked' && user.accessStatus === 'active'
        ? h(
            'p',
            { role: 'alert', class: 'mt-1 text-xs text-negative' },
            'The invitation is revoked, but the workspace profile still has access. Retry revoke to disable it.',
          )
        : null,
      user.authBanPending
        ? h(
            'p',
            { class: 'mt-1 text-xs text-caution' },
            'Auth ban pending; retry revoke to finish.',
          )
        : null,
      h(
        'p',
        { class: 'mt-1 text-xs text-subtle' },
        `Invited ${readableDate(user.invitedAt)} · Last sign-in ${readableDate(user.lastSignInAt)}`,
      ),
    ),
    h(
      'div',
      { class: 'admin-reference-actions' },
      user.status === 'active' && user.accessStatus === 'active'
        ? button([icon('key-round', 14, 'mr-1.5'), 'Reset link'], {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onclick: () => void createResetLink(user),
          })
        : null,
      user.status === 'invited' && user.accessStatus !== 'revoked'
        ? button('Resend', {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onclick: () => void resend(user),
          })
        : null,
      user.status === 'revoked'
        ? button([icon('undo-2', 14, 'mr-1.5'), 'Restore access'], {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onclick: () => requestRestore(user),
          })
        : null,
      canRevoke
        ? button(
            [
              icon('user-round-x', 14, 'mr-1.5'),
              user.status === 'revoked'
                ? 'Retry revoke'
                : user.status === 'invited'
                  ? 'Revoke'
                  : 'Suspend',
            ],
            {
              variant: 'ghost',
              size: 'sm',
              className: 'text-negative',
              disabled: busy,
              onclick: () => requestRevoke(user),
            },
          )
        : null,
    ),
  );
}
