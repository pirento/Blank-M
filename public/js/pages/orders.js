/**
 * Order review page: saved order plans, review status, cloud sync and (when
 * enabled) guarded live order placement through Zerodha.
 */
import { t } from '../core/i18n.js';
import {
  $,
  h,
  icon,
  pageData,
  button,
  buttonClass,
  card,
  cardHeader,
  cardContent,
  emptyState,
  badge,
  render,
  formatIstDateTime,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { notify, notifyError } from '../core/toast.js';
import { formatPlanningMoney, formatPlanningPrice } from '../../../shared/risk-calculator.js';
import { createOrderPlanStore, planSyncMessage } from '../lib/order-plans-store.js';
import { createBrokerPortfolio } from '../components/broker-portfolio.js';
import { openGtt, openLiveOrder } from './orders/live-dialogs.js';

const data = pageData();
const istTime = formatIstDateTime;
let mutationError = null;
let store = null;
const live = { state: null, orders: [], error: '' };
const ACTIVE = new Set(['submitting', 'placed', 'unknown']);
const STATUS_LABELS = {
  submitting: 'Sending to Zerodha',
  placed: 'Placed with Zerodha',
  rejected: 'Rejected',
  unknown: 'Outcome unknown — check Zerodha',
};

async function loadLive() {
  try {
    const result = await api('/api/live-orders');
    live.state = result.state;
    live.orders = result.orders;
    live.error = '';
  } catch (error) {
    live.error = errorMessage(error, 'Live order status could not be loaded.');
  }
  paint();
}

/** Why the live order button is unavailable for this plan, or null when it can be used. */
function liveBlocker(plan) {
  const state = live.state;
  if (!state) return live.error || 'Checking live order availability…';
  if (!state.enabled)
    return 'Live trading is turned off on this server. Plans stay for review only.';
  if (!state.accountEnabled)
    return 'Enable live orders in Settings to place this plan with Zerodha.';
  if (!state.mfaVerified) return 'Verify your authenticator to place live orders.';
  if (state.risk?.blocked) return `${state.risk.reasons[0]} Live orders are paused for today.`;
  if (live.orders.some((order) => order.planId === plan.id && ACTIVE.has(order.status)))
    return 'An order was already sent for this plan.';
  if (!plan.reviewedAt) return 'Mark the plan as reviewed first.';
  if (!state.marketOpen) return 'Live orders can be placed only while the market is open.';
  if (state.usedToday >= state.dailyLimit)
    return `Daily live order limit reached (${state.dailyLimit}).`;
  return null;
}

function mutate(action) {
  mutationError = null;
  try {
    action();
  } catch (reason) {
    mutationError =
      reason instanceof Error ? reason.message : 'Could not update the plan in this browser.';
    paint();
  }
}

function liveOrderLine(plan) {
  const orders = live.orders.filter((order) => order.planId === plan.id);
  if (!orders.length) return null;
  return h(
    'ul',
    { class: 'space-y-1 text-sm' },
    orders.map((order) =>
      h(
        'li',
        { class: 'flex flex-wrap items-center gap-2' },
        badge(
          STATUS_LABELS[order.status] ?? order.status,
          order.status === 'placed'
            ? 'positive'
            : order.status === 'rejected'
              ? 'negative'
              : 'caution',
        ),
        h(
          'span',
          { class: 'text-xs text-muted' },
          `${order.side} ${order.quantity} @ ₹${order.price}${order.brokerOrderId ? ` · order ${order.brokerOrderId}` : ''} · ${istTime(order.createdAt)} IST`,
        ),
        order.error ? h('span', { class: 'w-full text-xs text-negative' }, order.error) : null,
        gttLine(plan, order),
      ),
    ),
  );
}

const GTT_LABELS = {
  placed: 'Stop & target GTT placed',
  rejected: 'GTT rejected',
  unknown: 'GTT outcome unknown — check Kite',
};

/** GTT status for a live order, and the button to place one when it applies. */
function gttLine(plan, order) {
  const eligible = order.status === 'placed' && order.product === 'CNC' && order.side === 'BUY';
  if (!eligible && !order.gtt) return null;
  const gtt = order.gtt;
  return h(
    'div',
    { class: 'flex w-full flex-wrap items-center gap-2' },
    gtt
      ? [
          badge(
            GTT_LABELS[gtt.status] ?? gtt.status,
            gtt.status === 'placed'
              ? 'positive'
              : gtt.status === 'rejected'
                ? 'negative'
                : 'caution',
          ),
          gtt.stop
            ? h(
                'span',
                { class: 'text-xs text-muted' },
                `stop ₹${gtt.stop}${gtt.target ? ` · target ₹${gtt.target}` : ''}${gtt.triggerId ? ` · GTT ${gtt.triggerId}` : ''}`,
              )
            : null,
          gtt.error ? h('span', { class: 'w-full text-xs text-negative' }, gtt.error) : null,
        ]
      : order.autoGtt && eligible
        ? badge('Stop & target: placed automatically once filled', 'caution')
        : null,
    eligible && (!gtt || gtt.status === 'rejected')
      ? button(t('Place stop & target (GTT)'), {
          variant: 'outline',
          size: 'sm',
          onclick: () => openGtt(plan, order, { onDone: loadLive }),
        })
      : null,
  );
}

/** Starts a paper trade from a synced plan at the live price (no order is sent). */
async function startPaper(plan) {
  try {
    const { trade } = await api('/api/paper', { method: 'POST', body: { planId: plan.id } });
    notify(
      `Paper trade started: ${trade.symbol} at ₹${trade.entryPrice}. See Paper trading.`,
      'success',
    );
  } catch (error) {
    notifyError(error, 'Could not start the paper trade.');
  }
}

function planCard(plan) {
  const { estimate, inputs } = plan;
  const money = formatPlanningMoney;
  const rows = [
    ['Quantity', estimate.quantity.toLocaleString('en-IN')],
    ['Automatic quantity', estimate.suggestedQuantity.toLocaleString('en-IN')],
    ['Planned entry', formatPlanningPrice(inputs.entryPrice)],
    ['Planned stop', formatPlanningPrice(inputs.stopLoss)],
    ['Planned target', inputs.takeProfit ? formatPlanningPrice(inputs.takeProfit) : 'Not supplied'],
    ['Account risk budget', money(estimate.riskBudgetPaise)],
    ['Notional value', money(estimate.positionValuePaise)],
    ['Illustrative margin', money(estimate.requiredMarginPaise)],
    ['Capital reserved', money(estimate.capitalRequiredPaise)],
    ['Estimated stop costs', money(estimate.stopFeesPaise)],
    ['Estimated loss + costs', money(estimate.stopLossIncludingFeesPaise)],
    [
      'Estimated target costs',
      estimate.targetFeesPaise === null ? 'Not supplied' : money(estimate.targetFeesPaise),
    ],
    [
      'Estimated profit − costs',
      estimate.targetNetProfitPaise === null
        ? 'Not supplied'
        : money(estimate.targetNetProfitPaise),
    ],
  ];
  const review = h('input', {
    type: 'checkbox',
    class: 'focus-ring mt-1.5 h-4 w-4 accent-accent',
    checked: Boolean(plan.reviewedAt),
    'aria-label': `I have reviewed ${plan.symbol} ${plan.direction === 'Long' ? 'buy' : 'sell'} plan created ${istTime(plan.createdAt)} IST`,
  });
  review.addEventListener('change', () => mutate(() => store.setReviewed(plan.id, review.checked)));
  return card(
    {},
    cardHeader(
      'flex-wrap',
      h(
        'h3',
        { class: 'min-w-0 break-words text-lg font-normal text-fg' },
        `${plan.symbol} · ${plan.direction === 'Long' ? 'BUY' : 'SELL'} · ${plan.product}`,
      ),
      h(
        'span',
        { class: 'shrink-0 border border-line px-2 py-1 text-[10px] tracking-wider text-muted' },
        plan.reviewedAt ? 'REVIEWED PLAN' : 'SAVED PLAN',
      ),
    ),
    cardContent(
      'space-y-5',
      h(
        'dl',
        { class: 'grid grid-cols-1 gap-x-8 sm:grid-cols-2 xl:grid-cols-3' },
        rows.map(([labelText, value]) =>
          h(
            'div',
            { class: 'flex min-w-0 justify-between gap-3 border-b border-line py-3 text-sm' },
            h('dt', { class: 'text-muted' }, labelText),
            h('dd', { class: 'tnum min-w-0 break-all text-right' }, value),
          ),
        ),
      ),
      h(
        'p',
        { class: 'text-xs leading-5 text-muted' },
        `Created ${istTime(plan.createdAt)} IST · ${plan.strategySnapshot?.name ?? 'No strategy selected'}${plan.reviewedAt ? ` · Reviewed ${istTime(plan.reviewedAt)} IST` : ''}`,
      ),
      h(
        'details',
        { class: 'border border-line p-3' },
        h(
          'summary',
          { class: 'focus-ring cursor-pointer text-sm' },
          'Captured inputs, strategy and data source',
        ),
        h(
          'div',
          {
            class:
              'mt-3 space-y-3 break-words text-xs leading-5 text-muted [overflow-wrap:anywhere]',
          },
          h(
            'p',
            {},
            `Planning capital ₹${inputs.accountSize}; available ₹${inputs.availableCapital || inputs.accountSize}; account risk ${inputs.riskPercent}%; illustrative margin ${inputs.product === 'CNC' ? '100' : (inputs.marginPercent ?? '100')}%; ${inputs.quantity ? `manual quantity ${inputs.quantity}` : 'automatic quantity'}.`,
          ),
          inputs.priceMode === 'percent'
            ? h(
                'p',
                {},
                `Stop distance ${inputs.stopDistancePercent}%; risk : reward 1 : ${inputs.rewardMultiple}.`,
              )
            : null,
          h(
            'p',
            {},
            inputs.estimatedRoundTripCharges !== undefined &&
              inputs.estimatedRoundTripCharges !== ''
              ? `Manual round-trip cost estimate ₹${inputs.estimatedRoundTripCharges}.`
              : 'Configured fee assumptions captured when the plan was saved.',
          ),
          plan.quoteSnapshot
            ? h(
                'p',
                {},
                `Reference price ₹${plan.quoteSnapshot.price} · ${plan.quoteSnapshot.source} · ${plan.quoteSnapshot.currency ?? 'Currency unverified'} · retrieved ${istTime(plan.quoteSnapshot.fetchedAt)} IST. Provider timestamp ${plan.quoteSnapshot.asOf ? istTime(plan.quoteSnapshot.asOf) : 'unavailable'}; freshness unverified. Planned entry may have been edited.`,
              )
            : h('p', {}, 'Entry supplied manually. No quote snapshot was captured.'),
          plan.strategySnapshot?.rules
            ? h(
                'p',
                { class: 'whitespace-pre-wrap' },
                `Strategy conditions: ${plan.strategySnapshot.rules}`,
              )
            : null,
          plan.rulesSnapshot.length
            ? h(
                'ul',
                { class: 'space-y-2' },
                plan.rulesSnapshot.map((rule) =>
                  h(
                    'li',
                    { class: 'whitespace-pre-wrap' },
                    h('strong', {}, `${rule.section}:`),
                    ` ${rule.rule}`,
                  ),
                ),
              )
            : null,
          h(
            'p',
            {},
            'These are saved snapshots, not approved strategy versions. Later settings changes do not rewrite this estimate.',
          ),
        ),
      ),
      h(
        'label',
        { class: 'flex items-start gap-3 text-sm leading-6' },
        review,
        'I have reviewed this plan. Broker price and margin revalidation is still required.',
      ),
      liveOrderLine(plan),
      h(
        'p',
        { class: 'text-xs leading-5 text-muted', id: `execution-${plan.id}` },
        `${liveBlocker(plan) ?? 'Live orders are enabled for this plan.'} Stops and targets are planning assumptions; slippage, gaps and actual fees can increase losses.`,
      ),
      h(
        'div',
        { class: 'flex flex-wrap gap-3' },
        h(
          'button',
          {
            type: 'button',
            class: buttonClass(),
            disabled: Boolean(liveBlocker(plan)),
            'aria-describedby': `execution-${plan.id}`,
            onclick: () => openLiveOrder(plan, { onDone: loadLive }),
          },
          'Place live order',
        ),
        button([icon('beaker', 14, 'mr-2'), 'Paper trade'], {
          variant: 'outline',
          'aria-label': `Paper trade the ${plan.symbol} plan`,
          onclick: () => void startPaper(plan),
        }),
        button([icon('trash-2', 14, 'mr-2'), 'Remove plan'], {
          variant: 'outline',
          className: 'text-negative',
          onclick: () => mutate(() => store.removePlan(plan.id)),
        }),
      ),
    ),
  );
}

function paint() {
  if (!store) return;
  const status = store.syncStatus;
  render(
    $('[data-sync-status]'),
    h(
      'div',
      {
        class: 'border border-line bg-surface px-4 py-3 text-sm text-muted',
        role: 'status',
        'aria-label': t('Plan cloud sync'),
        'aria-live': 'polite',
      },
      planSyncMessage(status),
      status.state === 'error'
        ? button(t('Retry sync'), {
            variant: 'outline',
            className: 'ml-2 mt-2',
            onclick: () => store.retrySync(),
          })
        : null,
    ),
  );
  const error = store.error || mutationError;
  const errorBox = $('[data-plan-error]');
  errorBox.textContent = error || '';
  errorBox.hidden = !error;
  render(
    $('[data-plans]'),
    store.plans.length
      ? store.plans.map(planCard)
      : !store.error
        ? card(
            {},
            cardContent(
              '',
              emptyState({
                iconName: 'arrow-right-left',
                title: t('No prepared orders'),
                hint: t('Use the calculator to prepare a plan, then review it here.'),
                action: h(
                  'a',
                  { href: '/calculator', class: buttonClass() },
                  'Open calculator',
                  icon('arrow-right', 14, 'ml-2'),
                ),
              }),
            ),
          )
        : null,
  );
}

store = createOrderPlanStore(data.accountId, paint);
paint();
void loadLive();
render($('[data-broker-portfolio]'), createBrokerPortfolio({ available: Boolean(data.accountId) }));
