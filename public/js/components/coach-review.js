/**
 * AI coach card (Insights page): review today or the last seven days against
 * your own rules, and read earlier saved reviews.
 */
import {
  h,
  cn,
  button,
  select,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  formatIstDateTime,
  render,
  errorLine,
  statusLine,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { aiUnavailableNotice } from './ai-gate.js';

const STATUS = {
  followed: ['Followed', 'text-positive'],
  partly: ['Partly', 'text-caution'],
  broken: ['Broken', 'text-negative'],
  unclear: ['Unclear', 'text-muted'],
};

function list(title, items, render) {
  return items.length
    ? h(
        'div',
        { class: 'space-y-2' },
        h('h4', { class: 'text-xs uppercase tracking-wide text-muted' }, title),
        h('ul', { class: 'space-y-2 text-sm' }, items.map(render)),
      )
    : null;
}

function reviewView(saved) {
  const review = saved.review;
  return h(
    'div',
    { class: 'space-y-5' },
    h(
      'div',
      { class: 'flex flex-wrap items-baseline justify-between gap-2' },
      h(
        'p',
        { class: 'text-xs text-muted' },
        `${saved.period === 'day' ? saved.to : `${saved.from} to ${saved.to}`} · ${saved.tradeCount} trades · ${formatIstDateTime(saved.createdAt)} IST`,
      ),
      h('span', { class: 'tnum text-sm text-fg' }, `Discipline ${review.disciplineScore}/10`),
    ),
    h('p', { class: 'text-sm leading-6 text-fg' }, review.summary),
    list('Focus next session', review.focus, (item) =>
      h('li', { class: 'rounded-control border border-accent/40 bg-accent-soft px-3 py-2' }, item),
    ),
    list('Went well', review.wentWell, (item) => h('li', { class: 'text-fg' }, `+ ${item}`)),
    list('Recurring mistakes', review.mistakes, (item) =>
      h(
        'li',
        { class: 'rounded-control border border-line p-3' },
        h('p', { class: 'font-medium text-fg' }, item.pattern),
        h('p', { class: 'mt-1 text-xs text-muted' }, item.evidence),
        h('p', { class: 'mt-1 text-xs text-fg' }, `Fix: ${item.fix}`),
      ),
    ),
    list('Your rules', review.ruleAdherence, (item) =>
      h(
        'li',
        { class: 'flex flex-wrap gap-x-2' },
        h(
          'span',
          { class: cn('font-medium', STATUS[item.status]?.[1]) },
          STATUS[item.status]?.[0] ?? item.status,
        ),
        h('span', { class: 'text-fg' }, item.rule),
        item.note ? h('span', { class: 'w-full text-xs text-muted' }, item.note) : null,
      ),
    ),
    h(
      'p',
      { class: 'text-xs text-muted' },
      'AI feedback on your own journal entries; it can be wrong and is not investment advice.',
    ),
  );
}

/** @param {{ aiAvailable: boolean }} options */
export function createCoachReview({ aiAvailable }) {
  const root = h('div');
  const state = { reviews: [], selected: 0, busy: '', error: '', loading: true };

  async function load() {
    try {
      state.reviews = (await api('/api/ai/coach-reviews')).reviews;
    } catch (error) {
      state.error = errorMessage(error, 'Saved reviews could not be loaded.');
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function run(period) {
    if (state.busy) return;
    state.busy = period;
    state.error = '';
    paint();
    try {
      const { review } = await api('/api/ai/coach-review', {
        method: 'POST',
        body: { period },
        timeout: 120_000,
      });
      state.reviews = [review, ...state.reviews];
      state.selected = 0;
    } catch (error) {
      state.error = errorMessage(error, 'The coach review could not be completed.');
    } finally {
      state.busy = '';
      paint();
    }
  }

  function paint() {
    const current = state.reviews[state.selected];
    const picker =
      state.reviews.length > 1
        ? select(
            { id: 'coach-history', 'aria-label': 'Saved reviews' },
            state.reviews.map((review, index) => ({
              value: String(index),
              selected: index === state.selected,
              label: `${review.period === 'day' ? review.to : `Week to ${review.to}`} · ${formatIstDateTime(review.createdAt)}`,
            })),
          )
        : null;
    picker?.addEventListener('change', () => {
      state.selected = Number(picker.value);
      paint();
    });
    render(
      root,
      card(
        { 'aria-label': 'AI coach' },
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle('AI coach'),
            h(
              'p',
              { class: 'mt-1 text-sm text-muted' },
              'A review of your trades against your own rules, with what to focus on next.',
            ),
          ),
        ),
        cardContent(
          'space-y-4',
          aiAvailable
            ? h(
                'div',
                { class: 'flex flex-wrap gap-2' },
                button(state.busy === 'day' ? 'Reviewing…' : 'Review today', {
                  variant: 'outline',
                  disabled: Boolean(state.busy),
                  onclick: () => void run('day'),
                }),
                button(state.busy === 'week' ? 'Reviewing…' : 'Review last 7 days', {
                  disabled: Boolean(state.busy),
                  onclick: () => void run('week'),
                }),
                picker,
              )
            : aiUnavailableNotice('The AI coach'),
          state.error ? errorLine(state.error) : null,
          state.loading
            ? statusLine('Loading saved reviews…')
            : current
              ? reviewView(current)
              : h('p', { class: 'text-sm text-muted' }, 'No reviews yet.'),
        ),
      ),
    );
  }
  paint();
  void load();
  return root;
}
