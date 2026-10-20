/** Settings page — report a problem to the administrators. */
import { t } from '../../core/i18n.js';
import { $, h, button, card, cardHeader, cardTitle, cardContent, render } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { cardDescription, statusLine } from './shared.js';

const CATEGORIES = [
  ['bug', 'Something is broken'],
  ['data', 'Wrong numbers or data'],
  ['billing', 'Payment or Premium'],
  ['account', 'Sign-in or account'],
  ['other', 'Something else'],
];
const FIELD =
  'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-fg focus-ring';

/** Mounts the "Report a problem" card; the report goes to /api/account/problem-report. */
export function mountReportProblem() {
  const root = $('[data-report-problem]');
  if (!root) return;
  const category = h(
    'select',
    { id: 'problem-category', class: `${FIELD} h-10` },
    ...CATEGORIES.map(([value, text]) => h('option', { value }, text)),
  );
  const message = h('textarea', {
    id: 'problem-message',
    rows: 4,
    maxlength: '2000',
    class: FIELD,
    placeholder: 'What happened, on which page, and what you expected.',
  });
  const status = h('div');
  const send = button('Send report', {
    onclick: async () => {
      send.disabled = true;
      render(status, statusLine(''));
      try {
        await api('/api/account/problem-report', {
          method: 'POST',
          body: {
            category: category.value,
            message: message.value,
            page: document.referrer ? new URL(document.referrer).pathname : '',
          },
        });
        message.value = '';
        render(
          status,
          statusLine('Thank you. The team has your report and will email you when it is fixed.'),
        );
      } catch (error) {
        render(status, statusLine(errorMessage(error, 'The report could not be sent.'), 'alert'));
      } finally {
        send.disabled = false;
      }
    },
  });
  render(
    root,
    card(
      { id: 'report-problem' },
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Report a problem')),
          cardDescription('Tell the Pirento Blank team about a bug or anything that looks wrong.'),
        ),
      ),
      cardContent(
        'space-y-3',
        h('label', { for: 'problem-category', class: 'block text-sm' }, 'Type'),
        category,
        h('label', { for: 'problem-message', class: 'block text-sm' }, 'Details'),
        message,
        send,
        status,
      ),
    ),
  );
}
