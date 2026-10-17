/**
 * Position sizing and risk/reward maths with exact decimal arithmetic (paise).
 */
import { computeCharges } from './pnl.js';

/** Money is returned as safe integer paise, including signed target P&L. */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Preserve the decimal entered by the user rather than subtracting binary floats.
 * Scientific notation is supported; hexadecimal, NaN, infinity and underflow are not.
 * The bounds also prevent unbounded BigInt work on malformed persisted input.
 */
function parseDecimal(raw, allowZero = false) {
  const text = raw.trim();
  if (text.length === 0 || text.length > 400) return null;
  const match = /^(?:\+)?(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i.exec(text);
  const value = Number(text);
  if (!match || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    return null;
  }
  const exponent = Number(match[2] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 400) return null;
  const [whole = '', fraction = ''] = match[1].split('.');
  const digits = BigInt(whole + fraction);
  const scale = fraction.length - exponent;
  return {
    numerator: scale < 0 ? digits * 10n ** BigInt(-scale) : digits,
    denominator: scale > 0 ? 10n ** BigInt(scale) : 1n,
    value,
  };
}

/** Only an intentionally empty field enables an optional default. */
function hasInput(raw) {
  return raw !== undefined && raw !== '';
}

function compare(left, right) {
  return left.numerator * right.denominator - right.numerator * left.denominator;
}

function distance(high, low) {
  return {
    numerator: compare(high, low),
    denominator: high.denominator * low.denominator,
    value: high.value - low.value,
  };
}

function ceilDivide(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function paise(amount, quantity, roundUp) {
  const numerator = amount.numerator * quantity * 100n;
  return roundUp ? ceilDivide(numerator, amount.denominator) : numerator / amount.denominator;
}

function inMoneyRange(value) {
  return value >= 0n && value <= MAX_SAFE;
}

/** Our decimal fractions terminate; retain their digits without binary-float rounding. */
function decimalText(numerator, denominator) {
  const whole = numerator / denominator;
  let remainder = numerator % denominator;
  let fraction = '';
  while (remainder && fraction.length < 1200) {
    remainder *= 10n;
    fraction += String(remainder / denominator);
    remainder %= denominator;
  }
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Stop-loss and take-profit prices as exact decimal strings: stop distance is a percent of entry
 * and the target is reward multiple × that distance, mirrored for a short.
 * Returns `{ valid: true, stopLoss, takeProfit }` or `{ valid: false, errors }`.
 */
export function deriveRiskPrices(input) {
  const entry = parseDecimal(input.entryPrice);
  const stop = parseDecimal(input.stopDistancePercent ?? '');
  const reward = parseDecimal(input.rewardMultiple ?? '');
  const errors = {};
  if (!entry) errors.entryPrice = 'Enter a finite positive entry price.';
  if (!stop || stop.numerator >= 100n * stop.denominator) {
    errors.stopDistancePercent = 'Stop distance must be greater than 0% and less than 100%.';
  }
  if (!reward) errors.rewardMultiple = 'Enter a finite positive reward multiple.';
  if (input.direction !== 'Long' && input.direction !== 'Short')
    errors.direction = 'Choose Long or Short.';
  if (Object.keys(errors).length || !entry || !stop || !reward) return { valid: false, errors };
  const base = entry.numerator * stop.denominator * 100n;
  const distance = entry.numerator * stop.numerator;
  const denominator = entry.denominator * stop.denominator * 100n;
  const sign = input.direction === 'Long' ? 1n : -1n;
  const target = base * reward.denominator + sign * distance * reward.numerator;
  if (target <= 0n)
    return {
      valid: false,
      errors: { rewardMultiple: 'The planned target must remain above zero.' },
    };
  return {
    valid: true,
    stopLoss: decimalText(base - sign * distance, denominator),
    takeProfit: decimalText(target, denominator * reward.denominator),
  };
}

/**
 * Planning only. Loss and committed capital round up; budgets and gains round down.
 * Fees deliberately use the app's existing configured estimate, not an asserted
 * current broker tariff. Optional margin is a user-entered illustration; broker
 * eligibility, tick sizes and execution are never inferred.
 */
export function calculateRiskPlan(input, charges) {
  if (input.priceMode === 'percent') {
    const prices = deriveRiskPrices(input);
    if (!prices.valid) return prices;
    input = { ...input, stopLoss: prices.stopLoss, takeProfit: prices.takeProfit };
  }
  const errors = {};
  function readMoney(field, raw) {
    const parsed = parseDecimal(raw);
    if (!parsed || !inMoneyRange(paise(parsed, 1n, true))) {
      errors[field] = 'Enter a finite positive amount within the supported money range.';
      return null;
    }
    return parsed;
  }

  const account = readMoney('accountSize', input.accountSize);
  const capital = hasInput(input.availableCapital)
    ? readMoney('availableCapital', input.availableCapital)
    : account;
  const entry = readMoney('entryPrice', input.entryPrice);
  const stop = readMoney('stopLoss', input.stopLoss);
  const target = hasInput(input.takeProfit) ? readMoney('takeProfit', input.takeProfit) : null;
  const risk = parseDecimal(input.riskPercent);
  const margin = parseDecimal(input.product === 'CNC' ? '100' : (input.marginPercent ?? '100'));
  if (!margin || margin.numerator > 100n * margin.denominator) {
    errors.marginPercent = 'Illustrative margin must be greater than 0% and no more than 100%.';
  }
  if (input.product !== undefined && input.product !== 'MIS' && input.product !== 'CNC')
    errors.product = 'Choose MIS or CNC.';
  const manualFees = hasInput(input.estimatedRoundTripCharges)
    ? parseDecimal(input.estimatedRoundTripCharges, true)
    : null;
  if (
    hasInput(input.estimatedRoundTripCharges) &&
    (!manualFees || !inMoneyRange(paise(manualFees, 1n, true)))
  ) {
    errors.estimatedRoundTripCharges =
      'Enter a finite non-negative charge estimate within the supported money range.';
  }
  if (input.product === 'CNC' && charges.enabled && !hasInput(input.estimatedRoundTripCharges)) {
    errors.estimatedRoundTripCharges =
      'Enter an explicit round-trip charge estimate for CNC. Configured rates cover intraday trades, not delivery charges.';
  }
  if (!risk || risk.numerator > 100n * risk.denominator) {
    errors.riskPercent = 'Risk must be greater than 0% and no more than 100%.';
  }
  if (input.direction !== 'Long' && input.direction !== 'Short') {
    errors.direction = 'Choose Long or Short.';
  }
  if (account && capital && compare(capital, account) > 0n) {
    errors.availableCapital = 'Available capital cannot exceed the account size in this plan.';
  }
  if (entry && stop) {
    const delta = compare(stop, entry);
    if (input.direction === 'Long' ? delta >= 0n : delta <= 0n) {
      errors.stopLoss =
        input.direction === 'Long'
          ? 'For a long plan, the stop must be below the entry price.'
          : 'For a short plan, the stop must be above the entry price.';
    }
  }
  if (entry && target) {
    const delta = compare(target, entry);
    if (input.direction === 'Long' ? delta <= 0n : delta >= 0n) {
      errors.takeProfit =
        input.direction === 'Long'
          ? 'For a long plan, the target must be above the entry price.'
          : 'For a short plan, the target must be below the entry price.';
    }
  }

  let manualQuantity = null;
  if (hasInput(input.quantity)) {
    const quantity = parseDecimal(input.quantity, true);
    if (
      !quantity ||
      quantity.numerator % quantity.denominator !== 0n ||
      quantity.numerator / quantity.denominator > MAX_SAFE
    ) {
      errors.quantity =
        'Quantity must be a non-negative whole number within the safe integer range.';
    } else {
      manualQuantity = quantity.numerator / quantity.denominator;
    }
  }
  if (
    !manualFees &&
    charges.enabled &&
    [
      charges.brokeragePercent,
      charges.brokerageMaxPerOrder,
      charges.sttPercent,
      charges.exchangeTxnPercent,
      charges.sebiPercent,
      charges.gstPercent,
      charges.stampDutyPercent,
    ].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    errors.charges = 'Configured charge estimates must be finite and non-negative.';
  }
  if (Object.keys(errors).length || !account || !capital || !entry || !stop || !risk || !margin) {
    return { valid: false, errors };
  }

  const riskBudget =
    (account.numerator * risk.numerator) / (account.denominator * risk.denominator);
  const capitalLimit = paise(capital, 1n, false);
  if (riskBudget < 1n) errors.riskPercent = 'The risk budget must be at least ₹0.01.';
  if (capitalLimit < 1n) errors.availableCapital = 'Available capital must be at least ₹0.01.';
  if (Object.keys(errors).length) return { valid: false, errors };

  const lossPerShare = input.direction === 'Long' ? distance(entry, stop) : distance(stop, entry);
  const rewardPerShare = target
    ? input.direction === 'Long'
      ? distance(target, entry)
      : distance(entry, target)
    : null;

  function estimateFees(exit, quantity) {
    if (manualFees) return paise(manualFees, 1n, true);
    if (quantity === 0n) return 0n;
    if (!charges.enabled) return 0n;
    const estimate = computeCharges(
      {
        type: input.direction,
        entryPrice: entry.value,
        exitPrice: exit.value,
        quantity: Number(quantity),
      },
      charges,
    ).total;
    const decimal = parseDecimal(String(estimate), true);
    if (!decimal) return null;
    const result = paise(decimal, 1n, true);
    return inMoneyRange(result) ? result : null;
  }

  function stopScenario(quantity) {
    const position = paise(entry, quantity, true);
    const grossLoss = paise(lossPerShare, quantity, true);
    if (!inMoneyRange(position) || !inMoneyRange(grossLoss)) return null;
    const fees = estimateFees(stop, quantity);
    if (fees === null) return null;
    const loss = grossLoss + fees;
    const requiredMargin = ceilDivide(
      entry.numerator * quantity * margin.numerator,
      entry.denominator * margin.denominator,
    );
    const requiredCapital = requiredMargin + fees;
    if (!inMoneyRange(loss) || !inMoneyRange(requiredCapital)) return null;
    return { position, requiredMargin, grossLoss, fees, loss, requiredCapital };
  }

  // Non-negative fee rates make costs monotone, including capped brokerage.
  // Binary search avoids unit-by-unit retries for low-priced instruments.
  const capitalBound =
    (capitalLimit * entry.denominator * margin.denominator) / (entry.numerator * margin.numerator);
  const riskBound = (riskBudget * lossPerShare.denominator) / (100n * lossPerShare.numerator);
  let low = 0n;
  let high = [capitalBound, riskBound, MAX_SAFE].reduce((a, b) => (a < b ? a : b));
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const estimate = stopScenario(middle);
    if (estimate && estimate.loss <= riskBudget && estimate.requiredCapital <= capitalLimit) {
      low = middle;
    } else {
      high = middle - 1n;
    }
  }

  const quantity = manualQuantity ?? low;
  const estimate = stopScenario(quantity);
  if (!estimate) {
    return {
      valid: false,
      errors: {
        calculation: 'This quantity or charge estimate exceeds the supported money range.',
      },
    };
  }
  const targetFees = target ? estimateFees(target, quantity) : null;
  const targetGrossProfit = rewardPerShare ? paise(rewardPerShare, quantity, false) : null;
  if (
    target &&
    (targetFees === null || targetGrossProfit === null || !inMoneyRange(targetGrossProfit))
  ) {
    return {
      valid: false,
      errors: { takeProfit: 'The target estimate exceeds the supported money range.' },
    };
  }
  const targetNetProfit =
    targetGrossProfit !== null && targetFees !== null ? targetGrossProfit - targetFees : null;

  return {
    valid: true,
    plan: {
      quantity: Number(quantity),
      suggestedQuantity: Number(low),
      isManualQuantity: manualQuantity !== null,
      riskBudgetPaise: Number(riskBudget),
      availableCapitalPaise: Number(capitalLimit),
      positionValuePaise: Number(estimate.position),
      requiredMarginPaise: Number(estimate.requiredMargin),
      stopGrossLossPaise: Number(estimate.grossLoss),
      stopFeesPaise: Number(estimate.fees),
      stopLossIncludingFeesPaise: Number(estimate.loss),
      capitalRequiredPaise: Number(estimate.requiredCapital),
      targetGrossProfitPaise: targetGrossProfit === null ? null : Number(targetGrossProfit),
      targetFeesPaise: targetFees === null ? null : Number(targetFees),
      targetNetProfitPaise: targetNetProfit === null ? null : Number(targetNetProfit),
      netRewardRiskRatio:
        targetNetProfit !== null && estimate.loss > 0n
          ? Number(targetNetProfit) / Number(estimate.loss)
          : null,
      exceedsRiskBudget: estimate.loss > riskBudget,
      exceedsCapital: estimate.requiredCapital > capitalLimit,
    },
  };
}

/** Format integer paise without losing a cent when large amounts are divided by 100. */
export function formatPlanningMoney(value) {
  const paise = BigInt(value);
  const absolute = paise < 0n ? -paise : paise;
  return `${paise < 0n ? '-' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}.${String(
    absolute % 100n,
  ).padStart(2, '0')}`;
}

/** Keep exact accepted prices distinct, with at least two displayed decimal places. */
export function formatPlanningPrice(value) {
  const parsed = parseDecimal(value);
  if (!parsed || !inMoneyRange(paise(parsed, 1n, true))) return '—';
  const [whole, fraction = ''] = decimalText(parsed.numerator, parsed.denominator).split('.');
  return `₹${BigInt(whole).toLocaleString('en-IN')}.${fraction.padEnd(2, '0')}`;
}
