/**
 * Admin → Plans & billing: switch billing on, set the Premium price, free
 * trial and which features need Premium, open or close public sign-up, and
 * see recent payments. Razorpay keys are set in Integrations.
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
import { notify } from '../core/toast.js';
import { mfaNotice, money, when } from './shared.js';

const root = $('[data-admin-billing]');
const state = { billing: null, payments: [] };

function checkbox(id, checked, text, hint) {
  const box = h('input', { id, type: 'checkbox', class: 'mt-1 h-4 w-4 accent-accent', checked });
  return {
    box,
    element: h(
      'label',
      { class: 'flex items-start gap-3 text-sm', for: id },
      box,
      h('span', {}, text, hint ? h('span', { class: 'block text-xs text-muted' }, hint) : null),
    ),
  };
}

/** Asks the server to try the saved Razorpay keys and shows the answer. */
async function checkKeys() {
  try {
    const result = await api('/api/admin/billing/check-keys', { method: 'POST', body: {} });
    notify(
      `Razorpay accepted the keys (${result.mode} mode).${result.webhookSecretSet ? '' : ' Add the webhook secret too.'}`,
      result.webhookSecretSet ? 'success' : 'info',
    );
  } catch (error) {
    notify(errorMessage(error, 'Razorpay could not be checked.'), 'error');
  }
}

function planCard() {
  const { plan, allFeatures, razorpayConfigured, webhookUrl } = state.billing;
  const enabled = checkbox(
    'plan-enabled',
    plan.enabled,
    'Billing is on',
    'When off, every member has every feature for free (as before).',
  );
  const signup = checkbox(
    'plan-signup',
    plan.signupOpen,
    'Anyone can sign up',
    'Shows "Create account" on the login page; new members confirm their email and start the free trial. Needs email (SMTP) set up.',
  );
  const name = input({ id: 'plan-name', value: plan.name, maxlength: '40' });
  const price = input({
    id: 'plan-price',
    type: 'number',
    min: '1',
    step: '1',
    value: String(plan.priceMonthly),
  });
  const trial = input({
    id: 'plan-trial',
    type: 'number',
    min: '0',
    max: '365',
    step: '1',
    value: String(plan.trialDays),
  });
  const features = allFeatures.map((feature) => {
    const toggle = checkbox(
      `feature-${feature.key}`,
      plan.features.includes(feature.key),
      feature.label,
    );
    // Free members may still use a Premium feature this many times a month (0 = never).
    const freeUses = input({
      id: `free-${feature.key}`,
      type: 'number',
      min: '0',
      max: '100000',
      step: '1',
      value: String(plan.freeQuota?.[feature.key] ?? 0),
      class: 'w-24',
      'aria-label': `Free uses per month: ${feature.label}`,
    });
    return {
      key: feature.key,
      box: toggle.box,
      freeUses,
      element: h(
        'div',
        { class: 'flex flex-wrap items-start justify-between gap-3' },
        toggle.element,
        h(
          'label',
          { class: 'flex items-center gap-2 text-xs text-muted' },
          'Free / month',
          freeUses,
        ),
      ),
    };
  });
  return card(
    {},
    cardHeader('', cardTitle('Premium plan')),
    cardContent(
      'space-y-5',
      razorpayConfigured
        ? h(
            'p',
            { class: 'text-sm text-muted' },
            badge('Razorpay set up', 'positive'),
            ' Webhook URL for Razorpay (events: subscription.*, payment.failed): ',
            h('code', { class: 'break-all' }, webhookUrl ?? 'set APP_URL in .env'),
            ' ',
            button('Check keys', { variant: 'outline', size: 'sm', onclick: checkKeys }),
          )
        : h(
            'p',
            { role: 'note', class: 'border border-caution bg-caution-soft px-3 py-2 text-sm' },
            'Add the Razorpay keys in ',
            h('a', { href: '/admin/integrations', class: 'text-accent underline' }, 'Integrations'),
            ' before switching billing on.',
          ),
      enabled.element,
      h(
        'div',
        { class: 'grid gap-4 sm:grid-cols-3' },
        h('div', {}, label('Plan name', 'plan-name'), name),
        h('div', {}, label('Price per month (₹)', 'plan-price'), price),
        h('div', {}, label('Free trial (days)', 'plan-trial'), trial),
      ),
      h(
        'fieldset',
        { class: 'space-y-2' },
        h(
          'legend',
          { class: 'mb-2 text-sm text-fg' },
          'Premium features. Free / month: AI counts each AI request; every other feature counts days of use (the first use each day).',
        ),
        ...features.map((feature) => feature.element),
        h(
          'p',
          { class: 'text-xs text-muted' },
          'Always free: journal, trade book, CSV import, calculator, rules, watchlist and settings.',
        ),
      ),
      signup.element,
      h(
        'p',
        { class: 'text-xs text-muted' },
        'Changing the price applies to new subscriptions; current subscribers keep the price they joined at.',
      ),
      button('Save plan', {
        onclick: async () => {
          try {
            await api('/api/admin/billing', {
              method: 'PUT',
              body: {
                enabled: enabled.box.checked,
                signupOpen: signup.box.checked,
                name: name.value,
                priceMonthly: Number(price.value),
                trialDays: Number(trial.value),
                features: features
                  .filter((feature) => feature.box.checked)
                  .map((feature) => feature.key),
                freeQuota: Object.fromEntries(
                  features.map((feature) => [feature.key, Number(feature.freeUses.value) || 0]),
                ),
              },
            });
            notify('Plan saved.', 'success');
            await load();
          } catch (error) {
            notify(errorMessage(error, 'The plan could not be saved.'), 'error');
          }
        },
      }),
    ),
  );
}

function paymentsCard() {
  const rows = state.payments;
  return card(
    {},
    cardHeader('', cardTitle('Recent payments')),
    cardContent(
      '',
      rows.length
        ? h(
            'div',
            { class: 'overflow-x-auto' },
            h(
              'table',
              { class: 'w-full text-left text-sm' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  { class: 'text-xs text-muted' },
                  ...['When (IST)', 'Member', 'Amount', 'Status', 'Method'].map((text) =>
                    h('th', { scope: 'col', class: 'py-2 pr-4 font-normal' }, text),
                  ),
                ),
              ),
              h(
                'tbody',
                {},
                ...rows.map((payment) =>
                  h(
                    'tr',
                    { class: 'border-t border-line' },
                    h('td', { class: 'py-2 pr-4' }, when(payment.paidAt)),
                    h('td', { class: 'py-2 pr-4 break-all' }, payment.email ?? '—'),
                    h('td', { class: 'tnum py-2 pr-4' }, money(payment.amount)),
                    h(
                      'td',
                      { class: 'py-2 pr-4' },
                      badge(
                        payment.status,
                        payment.status === 'captured'
                          ? 'positive'
                          : payment.status === 'failed'
                            ? 'negative'
                            : 'neutral',
                      ),
                    ),
                    h('td', { class: 'py-2 pr-4' }, payment.method ?? '—'),
                  ),
                ),
              ),
            ),
          )
        : statusLine('No payments yet.'),
    ),
  );
}

async function load() {
  try {
    const [billing, payments] = await Promise.all([
      api('/api/admin/billing'),
      api('/api/admin/payments'),
    ]);
    state.billing = billing;
    state.payments = payments.payments;
    render(root, mfaNotice(), h('div', { class: 'grid gap-4' }, planCard(), paymentsCard()));
  } catch (error) {
    render(
      root,
      statusLine(
        errorMessage(error, 'Billing could not be loaded.'),
        'alert',
        'text-sm text-negative',
      ),
    );
  }
}

render(root, statusLine('Loading…'));
void load();
