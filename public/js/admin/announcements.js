/**
 * Admin → Announcements: write one email and send it to every active member,
 * or only to Premium or free members, then follow its progress. Members who
 * turned announcements off are skipped.
 */
import {
  $,
  h,
  render,
  button,
  input,
  label,
  statusLine,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  badge,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { notify } from '../core/toast.js';
import { data, mfaNotice, when } from './shared.js';

const root = $('[data-admin-announcements]');
const AUDIENCES = { all: 'All members', premium: 'Premium members', free: 'Free members' };
const state = { announcements: [], busy: false };
// What is typed survives the repaints (progress refreshes every 5 s, and errors repaint).
const draft = { subject: '', body: '', audience: 'all' };

function composeCard() {
  const subject = input({ id: 'announcement-subject', maxlength: '150', value: draft.subject });
  const body = h('textarea', {
    id: 'announcement-body',
    rows: 8,
    maxlength: '10000',
    class:
      'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-fg focus-ring',
  });
  body.value = draft.body;
  const audience = h(
    'select',
    {
      id: 'announcement-audience',
      class: 'h-10 w-full rounded-control border border-line bg-surface px-3 text-sm focus-ring',
    },
    ...Object.entries(AUDIENCES).map(([value, text]) =>
      h('option', { value, selected: value === draft.audience }, text),
    ),
  );
  subject.addEventListener('input', () => (draft.subject = subject.value));
  body.addEventListener('input', () => (draft.body = body.value));
  audience.addEventListener('change', () => (draft.audience = audience.value));
  const send = button(state.busy ? 'Sending…' : 'Send announcement', {
    disabled: state.busy || !data.health?.email,
    onclick: async () => {
      const confirmed = await confirmDialog({
        title: 'Send this email?',
        description: `It goes to ${AUDIENCES[audience.value].toLowerCase()} now and cannot be recalled.`,
        confirmLabel: 'Send',
      });
      if (!confirmed) return;
      state.busy = true;
      paint();
      try {
        await api('/api/admin/announcements', {
          method: 'POST',
          body: { subject: subject.value, body: body.value, audience: audience.value },
        });
        Object.assign(draft, { subject: '', body: '', audience: 'all' });
        notify('Sending started. Progress shows below.', 'success');
        await load();
      } catch (error) {
        notify(errorMessage(error, 'The announcement could not be sent.'), 'error');
      } finally {
        state.busy = false;
        paint();
      }
    },
  });
  return card(
    {},
    cardHeader('', cardTitle('New announcement')),
    cardContent(
      'space-y-4',
      data.health?.email
        ? null
        : statusLine('Set up email (SMTP) in Integrations before sending announcements.'),
      h('div', { class: 'space-y-2' }, label('Subject', 'announcement-subject'), subject),
      h('div', { class: 'space-y-2' }, label('Message (plain text)', 'announcement-body'), body),
      h('div', { class: 'space-y-2' }, label('Send to', 'announcement-audience'), audience),
      h(
        'p',
        { class: 'text-xs text-muted' },
        'Members who turned announcements off in Settings are skipped. A line telling them how is added to every email.',
      ),
      send,
    ),
  );
}

function historyCard() {
  return card(
    {},
    cardHeader('', cardTitle('Sent')),
    cardContent(
      'space-y-2',
      state.announcements.length
        ? h(
            'ul',
            { class: 'divide-y divide-line text-sm' },
            ...state.announcements.map((item) =>
              h(
                'li',
                { class: 'flex flex-wrap items-center justify-between gap-2 py-2' },
                h(
                  'div',
                  { class: 'min-w-0' },
                  h('p', { class: 'break-words' }, item.subject),
                  h(
                    'p',
                    { class: 'text-xs text-muted' },
                    `${when(item.createdAt)} · ${AUDIENCES[item.audience]} · ${item.sent} sent, ${item.skipped} skipped, ${item.failed} failed`,
                  ),
                ),
                badge(
                  item.status === 'done' ? 'Done' : 'Sending',
                  item.status === 'done' ? 'positive' : 'neutral',
                ),
              ),
            ),
          )
        : statusLine('Nothing sent yet.'),
    ),
  );
}

function paint() {
  render(root, mfaNotice(), h('div', { class: 'grid gap-4' }, composeCard(), historyCard()));
}

async function load() {
  try {
    state.announcements = (await api('/api/admin/announcements')).announcements;
  } catch (error) {
    notify(errorMessage(error, 'Announcements could not be loaded.'), 'error');
  }
  paint();
  // Keep the progress fresh while one is sending.
  if (state.announcements.some((item) => item.status === 'sending')) setTimeout(load, 5000);
}

paint();
void load();
