/**
 * Settings page — Plan & billing: the member's Premium status (trial days left,
 * paid until, granted), Subscribe (opens Razorpay's payment page), Cancel
 * renewal, and payment history. Hidden while billing is switched off.
 */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
  badge,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { confirmDialog } from '../../core/dialog.js';
import { cardDescription, statusLine } from './shared.js';

const rupees = (value) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
const day = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(
        new Date(value),
      )
    : '—';

/** What the member's current state means, in one sentence. */
function describe(membership, plan) {
  switch (membership.state) {
    case 'trial':
      return `Free trial — ${membership.daysLeft} day${membership.daysLeft === 1 ? '' : 's'} left (until ${day(membership.trialEndsAt)}).`;
    case 'active':
      return `${plan.name} — renews on ${day(membership.paidUntil)}.`;
    case 'cancelled':
      return `${plan.name} until ${day(membership.paidUntil)}; it will not renew.`;
    case 'granted':
      return `${plan.name} given by the administrator until ${day(membership.grantUntil)}.`;
    default:
      return `Free plan. ${plan.name} unlocks the features below for ${rupees(plan.priceMonthly)} a month.`;
  }
}

/** Mounts the Plan & billing card. */
export function mountBilling() {
  const root = $('[data-billing]');
  if (!root) return;
  const state = { info: null, busy: false, message: '' };

  async function act(action) {
    state.busy = true;
    state.message = '';
    paint();
    try {
      await action();
    } catch (error) {
      state.message = errorMessage(error, 'That did not work. Try again.');
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function load(refresh = false) {
    try {
      if (refresh) await api('/api/billing/refresh', { method: 'POST', body: {} });
      state.info = await api('/api/billing');
    } catch (error) {
      state.message = errorMessage(error, 'Your plan could not be loaded.');
    }
    paint();
  }

  function paint() {
    const info = state.info;
    if (!info)
      return render(
        root,
        state.message ? statusLine(state.message, 'alert', 'text-sm text-negative') : null,
      );
    // With billing off every feature is free, so there is nothing to show.
    if (!info.plan.enabled) return render(root);
    const { membership, plan, payments } = info;
    // Any live Razorpay subscription can be cancelled, whatever gives Premium right now (a grant,
    // the trial, or nothing while a failed charge is being retried).
    const renewing =
      ['authenticated', 'active', 'pending'].includes(membership.razorpayStatus) &&
      !membership.cancelAtPeriodEnd;
    const subscribe = button(
      state.busy ? 'Opening payment page…' : `Subscribe — ${rupees(plan.priceMonthly)}/month`,
      {
        disabled: state.busy || !info.paymentsAvailable,
        onclick: () =>
          void act(async () => {
            const { url } = await api('/api/billing/checkout', { method: 'POST', body: {} });
            // Razorpay's own page takes the payment; it returns here afterwards.
            window.location.assign(url);
          }),
      },
    );
    const cancel = button('Cancel renewal', {
      variant: 'outline',
      disabled: state.busy,
      onclick: () =>
        void act(async () => {
          const confirmed = await confirmDialog({
            title: 'Cancel renewal?',
            description: `You keep ${plan.name} until the end of the month you paid for.`,
            confirmLabel: 'Cancel renewal',
            destructive: true,
          });
          if (confirmed) {
            await api('/api/billing/cancel', { method: 'POST', body: {} });
            await load();
          }
        }),
    });
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h('div', {}, cardTitle(t('Plan & billing')), cardDescription(describe(membership, plan))),
          badge(
            membership.premium ? plan.name : 'Free',
            membership.premium ? 'positive' : 'neutral',
          ),
        ),
        cardContent(
          'space-y-4',
          h(
            'ul',
            { class: 'space-y-1 text-sm text-muted' },
            ...plan.features.map((feature) => h('li', {}, `• ${feature.label}`)),
          ),
          info.paymentsAvailable
            ? null
            : statusLine('Payments are not set up yet. Ask the administrator.'),
          h(
            'div',
            { class: 'flex flex-wrap gap-2' },
            renewing ? cancel : subscribe,
            button('Refresh status', {
              variant: 'ghost',
              disabled: state.busy,
              onclick: () => void load(true),
            }),
          ),
          statusLine(state.message, 'alert', 'text-sm text-negative'),
          payments.length
            ? h(
                'div',
                {},
                h('h4', { class: 'mb-2 text-sm text-fg' }, 'Payments'),
                h(
                  'ul',
                  { class: 'space-y-1 text-sm' },
                  ...payments.map((payment) =>
                    h(
                      'li',
                      { class: 'flex flex-wrap justify-between gap-2' },
                      h('span', {}, day(payment.paidAt)),
                      h('span', { class: 'tnum' }, `${rupees(payment.amount)} · ${payment.status}`),
                    ),
                  ),
                ),
              )
            : null,
        ),
      ),
    );
  }

  // Coming back from Razorpay's page: ask Razorpay for the latest status once.
  void load(new URLSearchParams(window.location.search).has('billing'));
}
