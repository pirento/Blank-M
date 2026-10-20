/**
 * Admin → Members → Access requests: requests from the home page form. Approving invites the
 * visitor by email (password link + Google sign-in); rejecting sends a polite email.
 */
import { $, h, render, button, badge } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { confirmDialog } from '../../core/dialog.js';
import { notify, notifyError } from '../../core/toast.js';
import { readableDate } from './shared.js';
import { refresh } from './email-members.js';

const root = $('[data-access-requests]');
const view = { requests: [], busy: null, error: '' };
const TONES = { pending: 'caution', approved: 'positive', rejected: 'neutral' };

async function decide(request, decision) {
  if (decision === 'reject') {
    const confirmed = await confirmDialog({
      title: `Reject ${request.email}?`,
      description: 'They get a short, polite email. They can ask again later.',
      confirmLabel: 'Reject',
    });
    if (!confirmed) return;
  }
  view.busy = request.id;
  paint();
  try {
    await api(`/api/admin/access-requests/${encodeURIComponent(request.id)}`, {
      method: 'POST',
      body: { decision },
    });
    notify(
      decision === 'approve'
        ? `Approved. ${request.email} was emailed their sign-in details.`
        : 'Request rejected.',
      'success',
    );
    if (decision === 'approve') void refresh();
  } catch (error) {
    notifyError(error, 'The request could not be updated.');
  }
  view.busy = null;
  await loadAccessRequests();
}

function row(request) {
  const pending = request.status === 'pending';
  return h(
    'div',
    { class: 'admin-reference-row' },
    h(
      'div',
      { class: 'min-w-0 space-y-1' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('p', { class: 'font-medium' }, request.name),
        h('p', { class: 'break-all text-muted' }, request.email),
        badge(request.status, TONES[request.status]),
      ),
      h(
        'p',
        { class: 'text-xs text-muted' },
        `Asked ${readableDate(request.createdAt)}${request.phone ? ` · ${request.phone}` : ''}${
          request.decidedAt ? ` · decided ${readableDate(request.decidedAt)}` : ''
        }`,
      ),
      request.message
        ? h('p', { class: 'whitespace-pre-line break-words' }, request.message)
        : null,
    ),
    pending
      ? h(
          'div',
          { class: 'admin-reference-actions' },
          button('Approve', {
            size: 'sm',
            disabled: Boolean(view.busy),
            onclick: () => decide(request, 'approve'),
          }),
          button('Reject', {
            size: 'sm',
            variant: 'outline',
            disabled: Boolean(view.busy),
            onclick: () => decide(request, 'reject'),
          }),
        )
      : null,
  );
}

function paint() {
  const pending = view.requests.filter((request) => request.status === 'pending').length;
  $('[data-access-request-count]').textContent = String(pending).padStart(2, '0');
  render(
    root,
    view.error
      ? h('p', { role: 'alert', class: 'admin-reference-error' }, view.error)
      : view.requests.length
        ? view.requests.map(row)
        : h('p', { class: 'admin-reference-empty' }, 'No requests yet.'),
  );
}

/** Loads and paints the access requests. */
export async function loadAccessRequests() {
  if (!root) return;
  try {
    view.requests = (await api('/api/admin/access-requests')).requests;
    view.error = '';
  } catch (error) {
    view.error = 'Access requests could not be loaded. Try Refresh.';
    notifyError(error, 'Could not load access requests.');
  }
  paint();
}
