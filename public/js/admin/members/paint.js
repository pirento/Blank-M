/**
 * Renders the whole administration page from the current state.
 */
import { $, h, button, render } from '../../core/dom.js';
import { userRow } from './email-members.js';
import { emailCreation, privateCreation, privateList } from './private-links.js';
import { state } from './shared.js';

/** Repaints the users page: invite method toggle and form, counts, members, private links and email invitations. */
export function paint() {
  const busy = Boolean(state.busy);
  $('[data-refresh-all]').disabled = state.loading || busy || state.private.busy;
  const errorBox = $('[data-load-error]');
  errorBox.textContent = state.loadError || '';
  errorBox.hidden = !state.loadError;

  render(
    $('[data-methods]'),
    button('Private link · 48 hours', {
      variant: state.method === 'manual' ? 'default' : 'outline',
      'aria-pressed': String(state.method === 'manual'),
      disabled: busy,
      onclick: () => {
        state.method = 'manual';
        paint();
      },
    }),
    button('Email invitation', {
      variant: state.method === 'email' ? 'default' : 'outline',
      'aria-pressed': String(state.method === 'email'),
      disabled: busy,
      onclick: () => {
        state.method = 'email';
        paint();
      },
    }),
  );
  render($('[data-invite]'), state.method === 'manual' ? privateCreation() : emailCreation());

  const members = state.users.filter(
    (entry) => entry.status === 'active' || entry.acceptedAt !== null,
  );
  const invitations = state.users.filter(
    (entry) => entry.status !== 'active' && entry.acceptedAt === null,
  );
  $('[data-member-count]').textContent = members.length.toString().padStart(2, '0');
  $('[data-invitation-count]').textContent = (invitations.length + state.private.records.length)
    .toString()
    .padStart(2, '0');
  render(
    $('[data-members]'),
    state.loading
      ? h('p', { role: 'status', class: 'admin-reference-empty' }, 'Loading users…')
      : members.length
        ? members.map(userRow)
        : state.loadError
          ? null
          : h('p', { class: 'admin-reference-empty' }, 'No accepted memberships.'),
  );
  render($('[data-private]'), privateList());
  render(
    $('[data-email-invitations]'),
    state.loading
      ? h('p', { role: 'status', class: 'admin-reference-empty' }, 'Loading invitations…')
      : invitations.length
        ? invitations.map(userRow)
        : state.loadError
          ? null
          : h('p', { class: 'admin-reference-empty' }, 'No pending email invitations.'),
  );
}
