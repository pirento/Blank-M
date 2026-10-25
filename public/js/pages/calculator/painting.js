/**
 * Repaints mode, quote, sync status and the estimate (with save / sync controls).
 */
import { $, h, icon, button, buttonClass, cn, render } from '../../core/dom.js';
import {
  calculateRiskPlan,
  deriveRiskPrices,
  formatPlanningMoney,
  formatPlanningPrice,
} from '../../../../shared/risk-calculator.js';
import { NSE_SYMBOL_RE } from '../../../../shared/ai-schemas.js';
import { planSyncMessage } from '../../lib/order-plans-store.js';
import {
  calculator,
  estimate,
  quoteNote,
  refreshQuote,
  rewardPresetError,
  syncButton,
  syncNote,
} from './layout.js';
import {
  accountId,
  errorElements,
  fields,
  inputs,
  rules,
  settings,
  state,
  storeRef,
  strategies,
} from './shared.js';

/** Shows the percent or absolute stop/target inputs for the price mode; locks margin for CNC. */
export function paintModes() {
  const percent = fields.priceMode === 'percent';
  for (const [field, visibleInPercent] of [
    ['stopDistancePercent', true],
    ['rewardMultiple', true],
    ['stopLoss', false],
    ['takeProfit', false],
  ]) {
    inputs[field].closest('[data-field]').hidden = percent !== visibleInPercent;
  }
  for (const element of calculator.querySelectorAll('[data-mode="percent"]'))
    element.hidden = !percent;
  inputs.marginPercent.disabled = fields.product === 'CNC';
}

/** Updates the quote note and enables Refresh only for a valid NSE symbol. */
export function paintQuote() {
  quoteNote.textContent =
    state.quoteState ||
    'Enter the planned entry manually. Quotes are reference snapshots, not execution prices.';
  refreshQuote.disabled = !NSE_SYMBOL_RE.test(state.symbol.trim().toUpperCase());
}

/** Updates the broker balance sync button and its status note. */
export function paintSync() {
  syncButton.disabled = state.syncing || !accountId;
  syncButton.textContent = state.syncing ? 'Reading broker balance…' : 'Sync broker balance';
  syncNote.textContent = state.syncMessage;
  syncNote.hidden = !state.syncMessage;
}

function errorNote(message) {
  return message ? h('p', { role: 'alert', class: 'mt-1 text-xs text-negative' }, message) : null;
}

function caution(text) {
  return h(
    'p',
    { role: 'alert', class: 'border border-caution bg-caution-soft p-3 text-sm' },
    text,
  );
}

function metric(labelText, value, hint) {
  return h(
    'div',
    { class: 'grid grid-cols-[1fr_auto] items-start gap-x-4 py-2.5 text-sm' },
    h('div', {}, h('span', { class: 'text-muted' }, labelText)),
    h('div', { class: 'tnum text-right text-fg' }, value),
    hint ? h('p', { class: 'col-span-2 mt-1 text-[11px] leading-4 text-muted' }, hint) : null,
  );
}

/**
 * Recalculates the risk plan and repaints the estimate: field errors, result rows, fee
 * details and the "Add to order review" button, which saves the plan and opens /orders.
 */
export function paintEstimate() {
  const result = calculateRiskPlan(fields, settings.charges);
  const plan = result.valid ? result.plan : null;
  const errors = result.valid ? {} : result.errors;
  const derived = fields.priceMode === 'percent' ? deriveRiskPrices(fields) : null;
  const prices = derived?.valid ? derived : fields;
  const symbol = state.symbol.trim().toUpperCase();
  const unsupported = fields.product === 'CNC' && fields.direction === 'Short';
  const strategyMissing = Boolean(
    state.strategyId && !strategies.some((strategy) => strategy.id === state.strategyId),
  );
  $('[data-strategy-missing]').hidden = !strategyMissing;
  const canPrepare = Boolean(
    !state.prepared &&
    accountId &&
    !strategyMissing &&
    NSE_SYMBOL_RE.test(symbol) &&
    plan &&
    plan.quantity > 0 &&
    !plan.exceedsRiskBudget &&
    !plan.exceedsCapital &&
    !unsupported,
  );

  for (const [field, element] of Object.entries(errorElements)) {
    const show =
      state.edited[field] ||
      fields[field]?.trim() ||
      (field === 'estimatedRoundTripCharges' && fields.product === 'CNC');
    const message = show ? errors[field] : undefined;
    element.textContent = message || '';
    element.hidden = !message;
    const control = inputs[field];
    control.classList.toggle('border-negative', Boolean(message));
    control.classList.toggle('border-line-strong', !message);
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
  rewardPresetError.textContent =
    errors.rewardMultiple && state.rewardPreset !== 'custom' ? errors.rewardMultiple : '';
  rewardPresetError.hidden = !rewardPresetError.textContent;

  const rows = [
    ['Instrument', symbol || '—'],
    ['Sample entry', plan ? formatPlanningPrice(fields.entryPrice) : '—'],
    ['Quantity', plan ? plan.quantity.toLocaleString('en-IN') : '—'],
    ['Automatic quantity', plan ? plan.suggestedQuantity.toLocaleString('en-IN') : '—'],
    ['Notional value', plan ? formatPlanningMoney(plan.positionValuePaise) : '—'],
    ['Illustrative margin', plan ? formatPlanningMoney(plan.requiredMarginPaise) : '—'],
    ['Planned stop', plan ? formatPlanningPrice(prices.stopLoss) : '—'],
    ['Planned target', plan && prices.takeProfit ? formatPlanningPrice(prices.takeProfit) : '—'],
    ['Loss at planned stop', plan ? formatPlanningMoney(plan.stopGrossLossPaise) : '—'],
    [
      'Profit at planned target',
      plan?.targetGrossProfitPaise != null ? formatPlanningMoney(plan.targetGrossProfitPaise) : '—',
    ],
    ['Estimated costs', plan ? formatPlanningMoney(plan.stopFeesPaise) : '—'],
    [
      'Loss incl. estimated costs',
      plan ? formatPlanningMoney(plan.stopLossIncludingFeesPaise) : '—',
    ],
    [
      'Profit after estimated costs',
      plan?.targetNetProfitPaise != null ? formatPlanningMoney(plan.targetNetProfitPaise) : '—',
    ],
  ];
  const prepare = h(
    'button',
    {
      type: 'button',
      class: buttonClass('default', 'default', 'w-full min-h-[48px]'),
      disabled: !canPrepare,
    },
    'Add to order review',
    icon('arrow-right', 14, 'ml-2'),
  );
  prepare.addEventListener('click', () => {
    if (!canPrepare || !plan) return;
    try {
      const strategy = strategies.find((item) => item.id === state.strategyId);
      storeRef.current.savePlan({
        symbol,
        direction: fields.direction,
        product: fields.product ?? 'MIS',
        inputs: { ...fields, stopLoss: prices.stopLoss, takeProfit: prices.takeProfit },
        estimate: plan,
        chargesSnapshot: { ...settings.charges },
        strategySnapshot: strategy
          ? { id: strategy.id, name: strategy.name, rules: strategy.rules }
          : null,
        rulesSnapshot: rules.map((rule) => ({
          id: rule.id,
          section: rule.section,
          rule: rule.rule,
        })),
        quoteSnapshot: state.quote,
      });
      state.prepared = true;
      window.location.assign('/orders');
    } catch (error) {
      state.saveError =
        error instanceof Error ? error.message : 'Could not save the plan in this browser.';
      paintEstimate();
    }
  });
  const sync = storeRef.current.syncStatus;
  render(
    estimate,
    h(
      'dl',
      { class: 'divide-y divide-line text-[12px] min-[761px]:text-[13px]' },
      rows.map(([labelText, value], index) =>
        h(
          'div',
          {
            class: cn(
              'flex min-w-0 justify-between gap-3 py-2.5 first:pt-0',
              index === 2 && 'py-4',
              index === 11 && 'mt-2.5 pt-[15px]',
            ),
          },
          h('dt', { class: 'text-muted' }, labelText),
          h(
            'dd',
            {
              class: cn(
                'tnum min-w-0 break-all text-right font-mono text-[13px] min-[761px]:text-sm',
                index === 2 && 'text-[26px] text-accent min-[761px]:text-[26px]',
                index === 6 && 'text-negative',
                index === 7 && 'text-positive',
                index === 12 &&
                  plan?.targetNetProfitPaise != null &&
                  plan.targetNetProfitPaise < 0 &&
                  'text-negative',
              ),
            },
            value,
          ),
        ),
      ),
    ),
    plan
      ? h(
          'details',
          { class: 'text-xs text-muted' },
          h('summary', { class: 'focus-ring cursor-pointer' }, 'Sizing and fee details'),
          h(
            'dl',
            { class: 'mt-3 divide-y divide-line' },
            metric(
              'Risk budget',
              formatPlanningMoney(plan.riskBudgetPaise),
              'Planning capital × account risk, rounded down to paise',
            ),
            metric(
              'Capital reserved in plan',
              formatPlanningMoney(plan.capitalRequiredPaise),
              `Illustrative margin + stop-scenario fee reserve; ${formatPlanningMoney(plan.availableCapitalPaise)} available`,
            ),
            plan.targetFeesPaise !== null
              ? metric(
                  'Estimated target costs',
                  formatPlanningMoney(plan.targetFeesPaise),
                  'Configured rates can produce different fees at the stop and target prices.',
                )
              : null,
            plan.netRewardRiskRatio !== null
              ? metric('Net reward / planned risk', `${plan.netRewardRiskRatio.toFixed(2)}×`)
              : null,
          ),
        )
      : null,
    fields.priceMode === 'percent' ? errorNote(errors.stopLoss) : null,
    fields.priceMode === 'percent' ? errorNote(errors.takeProfit) : null,
    errorNote(errors.charges),
    errorNote(errors.calculation),
    plan?.exceedsRiskBudget
      ? caution(
          'This quantity exceeds your risk budget, including estimated stop-scenario charges.',
        )
      : null,
    plan?.exceedsCapital
      ? caution(
          'This quantity exceeds your available capital after reserving estimated stop-scenario charges. Reduce the quantity or revise the plan.',
        )
      : null,
    plan?.quantity === 0
      ? caution(
          plan.isManualQuantity
            ? 'A zero quantity is an estimate only. Enter a positive whole number or clear the override to use automatic sizing.'
            : 'No whole share fits both the risk budget and available capital with these estimated charges.',
        )
      : null,
    unsupported
      ? caution(
          'Delivery sell requires verified holdings. CNC short plans cannot be prepared here.',
        )
      : null,
    !plan
      ? h(
          'p',
          { class: 'border border-dashed border-line p-3 text-sm text-muted' },
          'Enter positive account, risk, entry and stop values. The stop and optional target must match the selected direction.',
        )
      : null,
    h(
      'p',
      { class: 'text-xs leading-5 text-muted' },
      `${
        fields.estimatedRoundTripCharges !== ''
          ? Number(fields.estimatedRoundTripCharges) === 0
            ? 'Zero estimated costs excludes fees; no cost estimate was supplied.'
            : 'Fees use your manual round-trip estimate.'
          : settings.charges.enabled
            ? 'Fees use your configured estimates and may differ from actual broker charges.'
            : 'Charges are disabled in settings, so this plan excludes all fees.'
      } This is a manual plan, with no active orders. Margin eligibility and instrument lot/tick sizes are not verified. Slippage, price gaps and actual fees can increase losses beyond the planned stop loss and risk budget.`,
    ),
    errorNote(storeRef.current.error || state.saveError || undefined),
    prepare,
    h(
      'p',
      { class: 'text-xs text-muted' },
      'Saved in this browser, then synced to your private account. Preparing a plan does not place an order.',
    ),
    h(
      'div',
      {
        class: 'border border-line bg-surface px-4 py-3 text-sm text-muted',
        role: 'status',
        'aria-label': 'Plan cloud sync',
        'aria-live': 'polite',
      },
      planSyncMessage(sync),
      sync.state === 'error'
        ? button('Retry sync', {
            variant: 'outline',
            className: 'ml-2 mt-2',
            onclick: () => storeRef.current.retrySync(),
          })
        : null,
    ),
  );
}
