/**
 * Billing page: the member's Premium status (trial days left, paid until,
 * granted), this month's free uses of Premium features, Subscribe (opens
 * Razorpay's payment page), Cancel renewal, payment history with invoices, and
 * the member's details for future invoices.
 */
import { t } from '../core/i18n.js';
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
  input,
  label,
  select,
  textarea,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { cardDescription, statusLine } from './settings/shared.js';
import { GST_STATES } from '../../../shared/gst.js';

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

/** Payments, newest first, each linked to its invoice. */
function paymentsList(payments) {
  if (!payments.length) return null;
  return h(
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
          h(
            'span',
            { class: 'tnum' },
            `${rupees(payment.amount)} · ${payment.status}`,
            payment.invoice
              ? [
                  ' · ',
                  h(
                    'a',
                    {
                      href: `/billing/invoices/${payment.invoice}`,
                      class: 'text-accent underline',
                      target: '_blank',
                      rel: 'noopener',
                    },
                    t('Invoice {number}', { number: payment.invoice }),
                  ),
                ]
              : null,
          ),
        ),
      ),
    ),
  );
}

/** The member's name, state, GSTIN and address for future invoices. */
function detailsCard(details) {
  const name = input({ id: 'invoice-name', value: details.name, maxlength: '100' });
  const state = select({ id: 'invoice-state' }, [
    { value: '', label: t('Choose your state'), selected: !details.state },
    ...GST_STATES.map((item) => ({
      value: item.code,
      label: item.name,
      selected: item.code === details.state,
    })),
  ]);
  const gstin = input({
    id: 'invoice-gstin',
    value: details.gstin,
    maxlength: '15',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'aria-describedby': 'invoice-gstin-hint',
  });
  const address = textarea({ id: 'invoice-address', value: details.address, maxlength: '300' });
  const message = h('p', { role: 'status', class: 'text-sm' });
  const save = async () => {
    try {
      await api('/api/billing/details', {
        method: 'PUT',
        body: { name: name.value, state: state.value, gstin: gstin.value, address: address.value },
      });
      message.textContent = t('Details saved.');
    } catch (error) {
      message.textContent = errorMessage(error, t('Your details could not be saved.'));
    }
  };
  return card(
    { className: 'mt-6' },
    cardHeader(
      '',
      h(
        'div',
        {},
        cardTitle(t('Invoice details')),
        cardDescription(t('These details go on invoices issued from now on.')),
      ),
    ),
    cardContent(
      'space-y-4',
      h(
        'div',
        { class: 'grid gap-4 sm:grid-cols-2' },
        h('div', {}, label(t('Name on invoice'), 'invoice-name'), name),
        h('div', {}, label(t('State (place of supply)'), 'invoice-state'), state),
        h(
          'div',
          {},
          label(t('GSTIN (optional)'), 'invoice-gstin'),
          gstin,
          h(
            'p',
            { id: 'invoice-gstin-hint', class: 'mt-1 text-xs text-muted' },
            t('A GSTIN lets a business claim input tax credit on this payment.'),
          ),
        ),
        h('div', {}, label(t('Address (optional)'), 'invoice-address'), address),
      ),
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-3' },
        button(t('Save details'), { variant: 'outline', onclick: () => void save() }),
        message,
      ),
    ),
  );
}

/** Mounts the plan card. */
function mountBilling() {
  const root = $('[data-billing]');
  if (!root) return;
  const state = { info: null, busy: false, message: '' };
  // Built once, so a repaint (Refresh status) keeps what the member typed.
  let details = null;

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
    if (!info.plan.enabled) {
      return render(
        root,
        statusLine(t('Every feature is free right now. Nothing to pay.')),
        paymentsList(info.payments),
      );
    }
    details ??= detailsCard(info.billingDetails);
    const { membership, plan, payments, freeUsage = {} } = info;
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
            ...plan.features.map((feature) => {
              const free = membership.premium ? null : freeUsage[feature.key];
              return h(
                'li',
                { class: 'flex flex-wrap justify-between gap-2' },
                h('span', {}, `• ${feature.label}`),
                // Free members see how many of this month's free uses are left.
                free
                  ? h(
                      'span',
                      { class: 'tnum text-xs' },
                      `${Math.max(free.limit - free.used, 0)} of ${free.limit} free ${free.unit} left this month`,
                    )
                  : null,
              );
            }),
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
          paymentsList(payments),
        ),
      ),
      details,
    );
  }

  // Coming back from Razorpay's page: ask Razorpay for the latest status once.
  void load(new URLSearchParams(window.location.search).has('billing'));
}

mountBilling();
