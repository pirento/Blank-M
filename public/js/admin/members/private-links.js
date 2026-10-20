/**
 * Private invitation links: create one (shown once), list them and revoke an
 * unused link. Also holds the shared invite form and the email invite card.
 */
import { h, button, input, label, select } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { openModal } from '../../core/dialog.js';
import { notify, notifyError } from '../../core/toast.js';
import { z } from 'zod';
import {
  manualInvitationCreatedSchema,
  manualInvitationSchema,
} from '../../../../shared/manual-invitations.js';
import { refresh, withBusy } from './email-members.js';
import { paint } from './paint.js';
import { emailEnabled, ist, state } from './shared.js';

/** Reloads private link invitations from /api/admin/manual-invitations and validates them. */
export async function reloadPrivate() {
  const p = state.private;
  p.loading = true;
  p.listError = '';
  paint();
  try {
    const result = await api('/api/admin/manual-invitations');
    p.records = z.array(manualInvitationSchema).parse(result.invitations);
  } catch (error) {
    p.listError = errorMessage(error, 'Could not load private invitations.');
  } finally {
    p.loading = false;
    paint();
  }
}

function requestPrivateRevoke(invitation) {
  openModal({
    title: 'Revoke private invitation?',
    description: invitation.email,
    content: (close) =>
      h(
        'div',
        {},
        h(
          'p',
          { class: 'text-sm text-muted' },
          'This link will stop working. Any unfinished membership activation will remain blocked.',
        ),
        h(
          'div',
          { class: 'mt-5 flex flex-wrap justify-end gap-3' },
          button('Cancel', { variant: 'outline', onclick: close }),
          button('Confirm private invitation revoke', {
            variant: 'destructive',
            disabled: state.private.busy,
            onclick: async () => {
              close();
              const p = state.private;
              if (p.busy) return;
              p.busy = true;
              p.listError = '';
              paint();
              try {
                await api('/api/admin/manual-invitations/revoke', {
                  method: 'POST',
                  body: { id: invitation.id },
                });
                if (p.created?.invitation.id === invitation.id) p.created = null;
                p.busy = false;
                await reloadPrivate();
              } catch (error) {
                p.listError = errorMessage(error, 'Could not revoke this private invitation.');
              } finally {
                p.busy = false;
                paint();
              }
            },
          }),
        ),
      ),
  });
}

// What the administrator typed, kept across repaints (lists finish loading after the form shows).
const drafts = {};

function inviteForm({ idPrefix, emailLabel, roleLabel, submitLabel, busy, onSubmit }) {
  const draft = (drafts[idPrefix] ??= { email: '', role: 'member' });
  const email = input({
    id: `${idPrefix}-email`,
    type: 'email',
    required: true,
    autocomplete: 'email',
    placeholder: 'member@example.com',
    disabled: busy,
    value: draft.email,
  });
  const role = select({ id: `${idPrefix}-role`, disabled: busy }, [
    { value: 'member', label: 'Member', selected: draft.role === 'member' },
    { value: 'admin', label: 'Administrator', selected: draft.role === 'admin' },
  ]);
  const submit = button(submitLabel, { type: 'submit', disabled: busy || !draft.email.trim() });
  email.addEventListener('input', () => {
    draft.email = email.value;
    submit.disabled = busy || !email.value.trim();
  });
  role.addEventListener('change', () => (draft.role = role.value));
  const form = h(
    'form',
    { class: 'admin-reference-invite-form' },
    h('div', {}, label(emailLabel, email.id), email),
    h('div', {}, label(roleLabel, role.id), role),
    submit,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = email.value.trim().toLowerCase();
    if (!value) return;
    drafts[idPrefix] = { email: '', role: 'member' };
    void onSubmit(value, role.value);
  });
  return form;
}

/**
 * Builds the private invitation form; creating one shows the one-time 48-hour link with a
 * copy button and reloads the list.
 */
export function privateCreation() {
  const p = state.private;
  const created = p.created;
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'admin-reference-intro' },
      'Create a private invitation link, valid for 48 hours and usable once. No email is sent automatically. Share it only with the intended member.',
    ),
    inviteForm({
      idPrefix: 'manual-invite',
      emailLabel: 'Invitation email',
      roleLabel: 'Invitation role',
      submitLabel: p.busy ? 'Updating invitation…' : 'Create private invitation',
      busy: p.busy,
      onSubmit: async (email, role) => {
        if (p.busy) return;
        Object.assign(p, { busy: true, error: '', created: null, copied: false });
        paint();
        try {
          const result = await api('/api/admin/manual-invitations', {
            method: 'POST',
            body: { email, role },
          });
          p.created = manualInvitationCreatedSchema.parse(result);
          p.busy = false;
          await reloadPrivate();
        } catch (error) {
          p.error = errorMessage(error, 'Could not create a private invitation.');
        } finally {
          p.busy = false;
          paint();
        }
      },
    }),
    h(
      'div',
      { class: 'mt-4' },
      p.error ? h('p', { role: 'alert', class: 'mt-1 text-xs text-negative' }, p.error) : null,
    ),
    created
      ? (() => {
          const link = input({ id: 'manual-invite-link', value: created.url, readonly: true });
          link.addEventListener('focus', () => link.select());
          return h(
            'div',
            { class: 'my-5 space-y-3 border-t border-line pt-5' },
            h(
              'p',
              { role: 'status', class: 'text-sm text-muted' },
              'Invitation created for ',
              h('span', { class: 'break-all' }, created.invitation.email),
              `. No email was sent. Expires ${ist(created.invitation.expiresAt)} IST.`,
            ),
            label('Private invitation link', link.id),
            link,
            button(p.copied ? 'Copied private link' : 'Copy private link', {
              variant: 'outline',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(created.url);
                  p.copied = true;
                } catch {
                  p.error =
                    'Clipboard access is unavailable. Select and copy the private link field.';
                }
                paint();
              },
            }),
            h(
              'p',
              { class: 'text-xs text-muted' },
              'Copy this link before leaving. The original link cannot be retrieved later.',
            ),
          );
        })()
      : null,
  );
}

/** Builds the email invitation form, which posts to /api/admin/users/invite (disabled without SMTP). */
export function emailCreation() {
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'admin-reference-intro' },
      'Send a secure email invitation to an individual member. Delivery is not confirmed until the recipient receives the email.',
    ),
    emailEnabled
      ? null
      : h(
          'p',
          {
            role: 'note',
            class: 'mb-4 border border-caution bg-caution-soft px-3 py-2 text-sm text-fg',
          },
          'Email delivery is not configured on this server (SMTP_HOST and SMTP_FROM). Use a private link instead, or configure SMTP to send email invitations.',
        ),
    inviteForm({
      idPrefix: 'invite',
      emailLabel: 'Email',
      roleLabel: 'Role',
      submitLabel: 'Send secure invitation',
      busy: Boolean(state.busy) || !emailEnabled,
      onSubmit: (email, role) =>
        withBusy(email, async () => {
          try {
            await api('/api/admin/users/invite', { method: 'POST', body: { email, role } });
            notify('Invitation request accepted. Email delivery is not confirmed.', 'success');
            await refresh();
          } catch (error) {
            notifyError(error, 'Could not request the invitation.');
            await refresh();
          }
        }),
    }),
    h(
      'p',
      { class: 'admin-reference-note' },
      'Email invitations use the configured email service and its expiry policy. Choose Private link to create a one-use invitation with a 48-hour expiry and share it yourself.',
    ),
  );
}

/** Builds the private link invitations list with status, expiry and revoke buttons. */
export function privateList() {
  const p = state.private;
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'admin-reference-heading mb-5 flex-wrap' },
      h('h3', { class: 'text-base font-normal' }, 'Private link invitations'),
      button('Refresh private invitations', {
        variant: 'outline',
        size: 'sm',
        disabled: p.loading || p.busy,
        onclick: () => void reloadPrivate(),
      }),
    ),
    p.listError
      ? h('p', { role: 'alert', class: 'mt-1 text-xs text-negative' }, p.listError)
      : null,
    p.loading
      ? h('p', { role: 'status', class: 'admin-reference-empty' }, 'Loading private invitations…')
      : p.records.length
        ? p.records.map((invitation) =>
            h(
              'div',
              { class: 'admin-reference-row' },
              h(
                'div',
                { class: 'min-w-0' },
                h('p', { class: 'break-all' }, `${invitation.email} · ${invitation.role}`),
                h(
                  'p',
                  { class: 'mt-1 text-xs text-muted' },
                  `${invitation.status.replaceAll('_', ' ')} · Expires ${ist(invitation.expiresAt)} IST`,
                ),
                invitation.status === 'needs_review'
                  ? h(
                      'p',
                      { class: 'mt-1 text-xs text-caution' },
                      'Provisioning needs administrator review. This link cannot be retried.',
                    )
                  : null,
              ),
              ['pending', 'processing', 'needs_review', 'expired'].includes(invitation.status)
                ? button('Revoke', {
                    variant: 'ghost',
                    size: 'sm',
                    className: 'text-negative',
                    'aria-label': `Revoke private invitation for ${invitation.email}`,
                    disabled: p.busy,
                    onclick: () => requestPrivateRevoke(invitation),
                  })
                : null,
            ),
          )
        : p.listError
          ? null
          : h('p', { class: 'admin-reference-empty' }, 'No private link invitations.'),
  );
}
