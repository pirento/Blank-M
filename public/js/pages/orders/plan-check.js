/**
 * The pre-trade check dialog for one saved plan: warnings and journal facts worked out on the
 * server from the member's own trades and limits, then the AI review against their rules. It only
 * advises; placing the order stays a separate, confirmed step.
 */
import { t } from '../../core/i18n.js';
import { h } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { openModal } from '../../core/dialog.js';

const VERDICTS = {
  fits: { label: 'Fits your rules', tone: 'text-positive' },
  caution: { label: 'Go carefully', tone: 'text-caution' },
  skip: { label: 'Skip this trade', tone: 'text-negative' },
};

const money = (value) => `${value < 0 ? '−' : ''}₹${Math.abs(value).toLocaleString('en-IN')}`;

function historyLine(label, value) {
  if (!value || !value.trades) return `${label}: no trades yet`;
  return `${label}: ${value.trades} trades · ${value.winRate}% wins · ${money(value.netPnl)}`;
}

function result({ facts, warnings, review, reviewUnavailable }, symbol) {
  const verdict = review ? VERDICTS[review.verdict] : null;
  return h(
    'div',
    { class: 'space-y-5 text-sm leading-6' },
    verdict
      ? h(
          'div',
          { class: 'border border-line p-3' },
          h('p', { class: `font-semibold ${verdict.tone}` }, t(verdict.label)),
          h('p', { class: 'mt-1' }, review.summary),
        )
      : h('p', { class: 'text-muted' }, reviewUnavailable),
    warnings.length
      ? h(
          'ul',
          { class: 'space-y-2', 'aria-label': t('Warnings') },
          warnings.map((warning) =>
            h(
              'li',
              { class: warning.level === 'stop' ? 'text-negative' : 'text-caution' },
              `${warning.level === 'stop' ? '■' : '▲'} ${warning.text}`,
            ),
          ),
        )
      : h('p', { class: 'text-positive' }, t('No limit or warning stands against this plan.')),
    review?.ruleConflicts.length
      ? h(
          'div',
          {},
          h('p', { class: 'font-semibold' }, t('Rules this plan may break')),
          h(
            'ul',
            { class: 'mt-1 list-disc space-y-1 pl-5' },
            review.ruleConflicts.map((text) => h('li', {}, text)),
          ),
        )
      : null,
    review?.questions.length
      ? h(
          'div',
          {},
          h('p', { class: 'font-semibold' }, t('Answer before you place it')),
          h(
            'ul',
            { class: 'mt-1 list-disc space-y-1 pl-5' },
            review.questions.map((text) => h('li', {}, text)),
          ),
        )
      : null,
    h(
      'details',
      { class: 'border border-line p-3 text-xs text-muted' },
      h('summary', { class: 'focus-ring cursor-pointer text-sm text-fg' }, t('Your record')),
      h(
        'ul',
        { class: 'mt-2 space-y-1' },
        h('li', {}, historyLine(symbol, facts.symbol)),
        h('li', {}, historyLine('Same direction', facts.direction)),
        facts.strategy ? h('li', {}, historyLine('This strategy', facts.strategy)) : null,
        h('li', {}, historyLine('All trades', facts.overall)),
        h('li', {}, `Losing trades in a row: ${facts.lossStreak}`),
        h('li', {}, `Today: ${facts.today.trades} trades · ${money(facts.today.pnl)}`),
      ),
    ),
    h(
      'p',
      { class: 'text-xs text-muted' },
      t('A check of your own plan and rules, not investment advice. No order is sent from here.'),
    ),
  );
}

/** Opens the check for a synced plan (`plan.id`, `plan.symbol`). */
export function openPlanCheck(plan) {
  openModal({
    title: `${t('AI check')}: ${plan.symbol}`,
    content: () => {
      const body = h(
        'div',
        { 'aria-live': 'polite' },
        h('p', { class: 'text-muted' }, t('Checking your plan…')),
      );
      api('/api/ai/plan-check', { method: 'POST', body: { planId: plan.id } })
        .then((data) => body.replaceChildren(result(data, plan.symbol)))
        .catch((error) =>
          body.replaceChildren(
            h(
              'p',
              { class: 'text-negative' },
              errorMessage(error, 'The plan could not be checked.'),
            ),
          ),
        );
      return body;
    },
  });
}
