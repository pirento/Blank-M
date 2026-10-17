import { describe, expect, it } from 'vitest';
import { computeCharges } from '../../shared/pnl.js';
import {
  calculateRiskPlan,
  formatPlanningMoney,
  formatPlanningPrice,
} from '../../shared/risk-calculator.js';
import { DEFAULT_CHARGES } from '../../shared/types.js';

const NO_FEES = { ...DEFAULT_CHARGES, enabled: false };
const INPUT = {
  direction: 'Long',
  accountSize: '100000',
  riskPercent: '1',
  entryPrice: '100',
  stopLoss: '90',
  takeProfit: '120',
};

function plan(overrides = {}, charges = NO_FEES) {
  const result = calculateRiskPlan({ ...INPUT, ...overrides }, charges);
  expect(result.valid, JSON.stringify(result)).toBe(true);
  if (!result.valid) throw new Error(JSON.stringify(result.errors));
  return result.plan;
}

function expectError(overrides, field, charges = NO_FEES) {
  const result = calculateRiskPlan({ ...INPUT, ...overrides }, charges);
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.errors).toHaveProperty(field);
}

describe('planning direction and validation', () => {
  it('calculates symmetric fee-free long and short outcomes', () => {
    const long = plan();
    const short = plan({ direction: 'Short', stopLoss: '110', takeProfit: '80' });
    expect(long).toEqual(short);
    expect(long.quantity).toBe(100);
    expect(long.stopLossIncludingFeesPaise).toBe(100000);
    expect(long.targetNetProfitPaise).toBe(200000);
    expect(long.netRewardRiskRatio).toBe(2);
  });

  it.each([
    { direction: 'Long', stopLoss: '100' },
    { direction: 'Long', stopLoss: '101' },
    { direction: 'Short', stopLoss: '100', takeProfit: '80' },
    { direction: 'Short', stopLoss: '99', takeProfit: '80' },
  ])('rejects non-loss-side stops: %j', (values) => expectError(values, 'stopLoss'));

  it.each([
    { direction: 'Long', takeProfit: '100' },
    { direction: 'Long', takeProfit: '80' },
    { direction: 'Short', stopLoss: '110', takeProfit: '100' },
    { direction: 'Short', stopLoss: '110', takeProfit: '120' },
  ])('never turns a losing-side target into a profit: %j', (values) =>
    expectError(values, 'takeProfit'),
  );

  it.each(['accountSize', 'entryPrice', 'stopLoss', 'takeProfit', 'availableCapital'])(
    'rejects invalid %s values',
    (field) => {
      for (const value of ['0', '-1', 'NaN', 'Infinity', '-Infinity', '1e309', '1e-500', '0x10']) {
        expectError({ [field]: value }, field);
      }
    },
  );

  it.each(['', '0', '-1', 'NaN', 'Infinity', '100.00000000000000001'])(
    'rejects invalid risk percent %s',
    (riskPercent) => expectError({ riskPercent }, 'riskPercent'),
  );

  it('rejects missing required amounts and accepts a blank optional target', () => {
    for (const field of ['accountSize', 'entryPrice', 'stopLoss']) {
      expectError({ [field]: ' ' }, field);
    }
    const value = plan({ takeProfit: '' });
    expect(value.targetNetProfitPaise).toBeNull();
    expect(value.targetFeesPaise).toBeNull();
    expect(value.netRewardRiskRatio).toBeNull();
  });

  it.each(['quantity', 'availableCapital', 'takeProfit'])(
    'distinguishes empty optional %s from malformed or whitespace-only text',
    (field) => {
      for (const value of ['1e', '1e309', ' ', '  ', 'not a number']) {
        expectError({ [field]: value }, field);
      }
      expect(plan({ [field]: '' }).quantity).toBe(100);
    },
  );

  it('rejects an invalid direction at the runtime boundary', () => {
    expectError({ direction: 'Buy' }, 'direction');
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '1.00000000000000001'])(
    'rejects invalid or inexact integer override %s',
    (quantity) => expectError({ quantity }, 'quantity'),
  );

  it('accepts decimal and exponent representations of exact whole quantities', () => {
    expect(plan({ quantity: '2.0' }).quantity).toBe(2);
    expect(plan({ quantity: '2e1' }).quantity).toBe(20);
  });

  it('rejects an under-paise risk budget and available capital', () => {
    expectError({ riskPercent: '0.000001' }, 'riskPercent');
    expectError({ availableCapital: '0.001' }, 'availableCapital');
  });

  it('rejects available capital above the account size', () => {
    expectError({ availableCapital: '100001' }, 'availableCapital');
  });
});

describe('risk and available-capital limits', () => {
  it('compares rupees with rupees for a cheap stock with many shares', () => {
    const value = plan({ entryPrice: '10', stopLoss: '9', takeProfit: '' });
    expect(value.quantity).toBe(1000);
    expect(value.positionValuePaise).toBe(1000000);
    expect(value.exceedsCapital).toBe(false);
  });

  it('caps expensive stock size by entry value, without implying leverage', () => {
    const value = plan({ riskPercent: '5', entryPrice: '5000', stopLoss: '4990', takeProfit: '' });
    expect(value.quantity).toBe(20);
    expect(value.capitalRequiredPaise).toBe(10000000);
    expect(value.stopLossIncludingFeesPaise).toBe(20000);
    expect(value.exceedsCapital).toBe(false);
  });

  it('uses separately entered available cash without changing the account-risk budget', () => {
    const value = plan({ availableCapital: '500' });
    expect(value.quantity).toBe(5);
    expect(value.riskBudgetPaise).toBe(100000);
    expect(value.availableCapitalPaise).toBe(50000);
  });

  it('keeps manual quantity editable and flags each breached limit', () => {
    const value = plan({ quantity: '1001' });
    expect(value.quantity).toBe(1001);
    expect(value.suggestedQuantity).toBe(100);
    expect(value.isManualQuantity).toBe(true);
    expect(value.exceedsRiskBudget).toBe(true);
    expect(value.exceedsCapital).toBe(true);
    const cashOnly = plan({ availableCapital: '500', quantity: '6' });
    expect(cashOnly.exceedsRiskBudget).toBe(false);
    expect(cashOnly.exceedsCapital).toBe(true);
  });

  it('returns zero automatic shares if one share cannot fit', () => {
    const value = plan({ accountSize: '10', entryPrice: '100', stopLoss: '99', takeProfit: '' });
    expect(value.quantity).toBe(0);
    expect(value.stopLossIncludingFeesPaise).toBe(0);
    expect(value.capitalRequiredPaise).toBe(0);
  });

  it('accepts 100% risk but never more', () => {
    expect(plan({ riskPercent: '100' }).quantity).toBe(1000);
    expectError({ riskPercent: '100.01' }, 'riskPercent');
  });
});

describe('configured charge estimates', () => {
  it('includes the existing configured fee estimate when sizing the stop scenario', () => {
    const value = plan({}, DEFAULT_CHARGES);
    const stopFees = computeCharges(
      { type: 'Long', entryPrice: 100, exitPrice: 90, quantity: value.quantity },
      DEFAULT_CHARGES,
    ).total;
    expect(value.quantity).toBeLessThan(100);
    expect(value.stopFeesPaise).toBe(Math.round(stopFees * 100));
    expect(value.stopLossIncludingFeesPaise).toBe(value.stopGrossLossPaise + value.stopFeesPaise);
    expect(value.stopLossIncludingFeesPaise).toBeLessThanOrEqual(value.riskBudgetPaise);
    const next = plan({ quantity: String(value.quantity + 1) }, DEFAULT_CHARGES);
    expect(next.exceedsRiskBudget || next.exceedsCapital).toBe(true);
  });

  it('reserves stop-scenario fees alongside notional for the cash limit', () => {
    const value = plan({ availableCapital: '1000' }, DEFAULT_CHARGES);
    expect(value.quantity).toBe(9);
    expect(value.capitalRequiredPaise).toBe(value.positionValuePaise + value.stopFeesPaise);
    expect(plan({ availableCapital: '1000', quantity: '10' }, DEFAULT_CHARGES).exceedsCapital).toBe(
      true,
    );
  });

  it('models separate long and short target/stop charge legs', () => {
    for (const direction of ['Long', 'Short']) {
      const stop = direction === 'Long' ? 90 : 110;
      const target = direction === 'Long' ? 120 : 80;
      const value = plan(
        { direction, stopLoss: String(stop), takeProfit: String(target), quantity: '10' },
        DEFAULT_CHARGES,
      );
      expect(value.stopFeesPaise).toBe(
        Math.round(
          computeCharges(
            { type: direction, entryPrice: 100, exitPrice: stop, quantity: 10 },
            DEFAULT_CHARGES,
          ).total * 100,
        ),
      );
      expect(value.targetFeesPaise).toBe(
        Math.round(
          computeCharges(
            { type: direction, entryPrice: 100, exitPrice: target, quantity: 10 },
            DEFAULT_CHARGES,
          ).total * 100,
        ),
      );
      expect(value.targetNetProfitPaise).toBe(value.targetGrossProfitPaise - value.targetFeesPaise);
      expect(value.netRewardRiskRatio).toBe(
        value.targetNetProfitPaise / value.stopLossIncludingFeesPaise,
      );
    }
  });

  it('reports a negative net target result honestly when fees exceed the price gain', () => {
    const value = plan({ takeProfit: '100.001' }, DEFAULT_CHARGES);
    expect(value.targetNetProfitPaise).toBeLessThan(0);
    expect(value.netRewardRiskRatio).toBeLessThan(0);
  });

  it('returns zero if fees consume the entire risk budget', () => {
    const highFees = { ...DEFAULT_CHARGES, brokeragePercent: 100, brokerageMaxPerOrder: 10000 };
    expect(plan({ accountSize: '1000', riskPercent: '1' }, highFees).quantity).toBe(0);
  });

  it('allows disabled fees and rejects malformed enabled fee settings', () => {
    for (const field of [
      'brokeragePercent',
      'brokerageMaxPerOrder',
      'sttPercent',
      'exchangeTxnPercent',
      'sebiPercent',
      'gstPercent',
      'stampDutyPercent',
    ]) {
      for (const badValue of [-1, NaN, Infinity]) {
        expectError({}, 'charges', { ...DEFAULT_CHARGES, [field]: badValue });
      }
    }
    const value = plan({}, { ...DEFAULT_CHARGES, enabled: false, brokeragePercent: NaN });
    expect(value.quantity).toBe(100);
    expect(value.stopFeesPaise).toBe(0);
  });

  it('does not produce infinity for extreme but finite configured charges', () => {
    const value = plan({}, { ...DEFAULT_CHARGES, gstPercent: Number.MAX_VALUE });
    expect(value.quantity).toBe(0);
    expectError({ quantity: '100' }, 'calculation', {
      ...DEFAULT_CHARGES,
      gstPercent: Number.MAX_VALUE,
    });
  });
});

describe('conservative decimal arithmetic and supported ranges', () => {
  it('does not lose a share because 0.3 minus 0.2 is a binary floating approximation', () => {
    const value = plan({
      accountSize: '100',
      riskPercent: '1',
      entryPrice: '0.3',
      stopLoss: '0.2',
      takeProfit: '0.5',
    });
    expect(value.quantity).toBe(10);
    expect(value.stopLossIncludingFeesPaise).toBe(100);
    expect(value.targetNetProfitPaise).toBe(200);
  });

  it('rounds loss/capital up and budgets/reward down, without inventing a tick size', () => {
    const value = plan({
      accountSize: '100.019',
      riskPercent: '1',
      entryPrice: '10.001',
      stopLoss: '9.667',
      takeProfit: '10.3349',
      quantity: '3',
    });
    expect(value.riskBudgetPaise).toBe(100);
    expect(value.availableCapitalPaise).toBe(10001);
    expect(value.stopGrossLossPaise).toBe(101);
    expect(value.positionValuePaise).toBe(3001);
    expect(value.targetGrossProfitPaise).toBe(100);
    expect(value.exceedsRiskBudget).toBe(true);
    expect(value.suggestedQuantity).toBe(2);
  });

  it('handles exact budget boundaries and precision finer than a JS Number', () => {
    const exact = plan({
      entryPrice: '100.1',
      stopLoss: '100',
      riskPercent: '0.0003',
      takeProfit: '',
    });
    expect(exact.quantity).toBe(3);
    const fractionOver = plan({
      entryPrice: '100.10000000000000001',
      stopLoss: '100',
      riskPercent: '0.0003',
      takeProfit: '',
    });
    expect(fractionOver.quantity).toBe(2);
  });

  it('caps tiny-price sizing at Number.MAX_SAFE_INTEGER', () => {
    const value = plan({
      accountSize: '100000',
      riskPercent: '100',
      entryPrice: '1e-20',
      stopLoss: '5e-21',
      takeProfit: '',
    });
    expect(value.quantity).toBe(Number.MAX_SAFE_INTEGER);
    expect(value.exceedsRiskBudget).toBe(false);
    expect(value.exceedsCapital).toBe(false);
    expect(
      plan({
        accountSize: '100000',
        riskPercent: '100',
        entryPrice: '1e-20',
        stopLoss: '5e-21',
        takeProfit: '',
        quantity: String(Number.MAX_SAFE_INTEGER),
      }).quantity,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts max-safe paise, rejecting values a fraction of a paise over it', () => {
    const value = plan({
      accountSize: '90071992547409.91',
      riskPercent: '100',
      entryPrice: '90071992547409.91',
      stopLoss: '90071992547409.90',
      takeProfit: '',
    });
    expect(value.availableCapitalPaise).toBe(Number.MAX_SAFE_INTEGER);
    expect(value.positionValuePaise).toBe(Number.MAX_SAFE_INTEGER);
    expect(value.quantity).toBe(1);
    expectError({ accountSize: '90071992547409.911' }, 'accountSize');
    expectError({ entryPrice: '90071992547409.92' }, 'entryPrice');
    expectError({ quantity: String(Number.MAX_SAFE_INTEGER) }, 'calculation');
  });

  it('rejects unrepresentable target totals rather than rendering infinity or rounded nonsense', () => {
    expectError({ takeProfit: '90071992547409', quantity: '100' }, 'takeProfit');
  });

  it('formats large safe paise without a lost cent and keeps negative signs', () => {
    expect(formatPlanningMoney(Number.MAX_SAFE_INTEGER)).toBe('₹9,00,71,99,25,47,409.91');
    expect(formatPlanningMoney(-101)).toBe('-₹1.01');
    expect(formatPlanningMoney(0)).toBe('₹0.00');
  });

  it('keeps both limits for varied decimal plans and proves the next whole share cannot fit', () => {
    for (let seed = 1; seed <= 180; seed++) {
      const direction = seed % 2 ? 'Long' : 'Short';
      const entryPaise = 1000 + ((seed * 7919) % 200000);
      const gapPaise = 1 + ((seed * 13) % 997);
      const stopPaise = entryPaise + (direction === 'Long' ? -gapPaise : gapPaise);
      const input = {
        direction,
        accountSize: String(500 + seed * 107),
        availableCapital: String(300 + seed * 79),
        riskPercent: String(((seed % 10) + 1) / 10),
        entryPrice: String(entryPaise / 100),
        stopLoss: String(stopPaise / 100),
        takeProfit: '',
      };
      const fees = seed % 3 ? DEFAULT_CHARGES : NO_FEES;
      const value = plan(input, fees);
      expect(Number.isSafeInteger(value.quantity)).toBe(true);
      expect(value.stopLossIncludingFeesPaise).toBeLessThanOrEqual(value.riskBudgetPaise);
      expect(value.capitalRequiredPaise).toBeLessThanOrEqual(value.availableCapitalPaise);
      const next = plan({ ...input, quantity: String(value.quantity + 1) }, fees);
      expect(next.exceedsRiskBudget || next.exceedsCapital).toBe(true);
    }
  });
});

describe('illustrative product, margin and manual charges', () => {
  it('does not silently apply intraday fees to a delivery plan', () => {
    expectError({ product: 'CNC' }, 'estimatedRoundTripCharges', DEFAULT_CHARGES);
    const delivery = plan({ product: 'CNC', estimatedRoundTripCharges: '45' }, DEFAULT_CHARGES);
    expect(delivery.stopFeesPaise).toBe(4500);
    expect(delivery.targetFeesPaise).toBe(4500);
  });
  it('separates notional from illustrative margin and reserves manual costs', () => {
    const value = plan({
      accountSize: '1000',
      riskPercent: '100',
      entryPrice: '100',
      stopLoss: '99',
      takeProfit: '103',
      marginPercent: '20',
      estimatedRoundTripCharges: '10',
    });
    expect(value.quantity).toBe(49);
    expect(value.positionValuePaise).toBe(490000);
    expect(value.requiredMarginPaise).toBe(98000);
    expect(value.capitalRequiredPaise).toBe(99000);
    expect(value.stopLossIncludingFeesPaise).toBe(5900);
    expect(value.targetNetProfitPaise).toBe(13700);
  });

  it('forces full capital for CNC even if a lower margin was supplied', () => {
    const value = plan({
      accountSize: '1000',
      riskPercent: '100',
      entryPrice: '100',
      stopLoss: '99',
      product: 'CNC',
      marginPercent: '20',
      estimatedRoundTripCharges: '10',
    });
    expect(value.quantity).toBe(9);
    expect(value.requiredMarginPaise).toBe(value.positionValuePaise);
  });

  it('lets an explicit zero estimate replace configured fees', () => {
    const value = plan({ estimatedRoundTripCharges: '0' }, DEFAULT_CHARGES);
    expect(value.quantity).toBe(100);
    expect(value.stopFeesPaise).toBe(0);
    expect(value.targetFeesPaise).toBe(0);
  });

  it('caps fee-inclusive risk independently of margin', () => {
    const value = plan({ estimatedRoundTripCharges: '19.999', marginPercent: '10' });
    expect(value.quantity).toBe(98);
    expect(value.stopFeesPaise).toBe(2000);
    expect(value.stopLossIncludingFeesPaise).toBe(100000);
  });

  it('checks manual overrides against margin plus fee reserve', () => {
    const value = plan({
      accountSize: '1000',
      riskPercent: '100',
      marginPercent: '20',
      quantity: '50',
      estimatedRoundTripCharges: '0.01',
    });
    expect(value.exceedsCapital).toBe(true);
    expect(value.capitalRequiredPaise).toBe(100001);
  });

  it.each(['0', '-1', '100.00000000000001', 'Infinity', '1e', ' '])(
    'rejects malformed margin %s',
    (marginPercent) => expectError({ marginPercent }, 'marginPercent'),
  );
  it.each(['-1', 'Infinity', '1e', ' '])(
    'rejects malformed fee override %s',
    (estimatedRoundTripCharges) =>
      expectError({ estimatedRoundTripCharges }, 'estimatedRoundTripCharges'),
  );
});

describe('percentage stop and reward planning', () => {
  it('derives the same exact outcomes as direct prices', () => {
    expect(plan({ priceMode: 'percent', stopDistancePercent: '10', rewardMultiple: '2' })).toEqual(
      plan(),
    );
    expect(
      plan({
        direction: 'Short',
        priceMode: 'percent',
        stopDistancePercent: '10',
        rewardMultiple: '2',
      }),
    ).toEqual(plan());
  });

  it('rejects a short target crossing zero', () => {
    expectError(
      { direction: 'Short', priceMode: 'percent', stopDistancePercent: '50', rewardMultiple: '2' },
      'rewardMultiple',
    );
  });

  it.each(['0', '100', '-1', '1e', ' '])(
    'rejects invalid percentage stop %s',
    (stopDistancePercent) =>
      expectError(
        { priceMode: 'percent', stopDistancePercent, rewardMultiple: '3' },
        'stopDistancePercent',
      ),
  );
});

describe('prototype boundary calculations', () => {
  it('treats explicit zero as an estimate and preserves fixed manual costs', () => {
    const value = plan({ quantity: '0', estimatedRoundTripCharges: '25.01' });
    expect(value).toMatchObject({
      quantity: 0,
      isManualQuantity: true,
      positionValuePaise: 0,
      stopGrossLossPaise: 0,
      requiredMarginPaise: 0,
      stopFeesPaise: 2501,
      stopLossIncludingFeesPaise: 2501,
      capitalRequiredPaise: 2501,
      targetNetProfitPaise: -2501,
    });
    expect(plan({ quantity: '0', estimatedRoundTripCharges: '1001' }).exceedsRiskBudget).toBe(true);
    expect(plan({ quantity: '0', estimatedRoundTripCharges: '100001' }).exceedsCapital).toBe(true);
  });

  it('matches the prototype sizing equations across both directions, margins and fixed fees', () => {
    for (const direction of ['Long', 'Short']) {
      for (const marginPercent of [5, 20, 100]) {
        for (const entry of [1, 100, 5000]) {
          for (const fees of [0, 0.01, 10, 999, 1001]) {
            const value = plan({
              direction,
              entryPrice: String(entry),
              priceMode: 'percent',
              stopDistancePercent: '1',
              rewardMultiple: '3',
              marginPercent: String(marginPercent),
              estimatedRoundTripCharges: String(fees),
            });
            // Independent integer equations: budget=100000 paise, capital=10000000 paise,
            // one-percent stop distance in paise=entry, margin per share in paise=entry*margin%.
            const feePaise = Math.round(fees * 100);
            const expected = Math.max(
              0,
              Math.min(
                Math.floor((100000 - feePaise) / entry),
                Math.floor((10000000 - feePaise) / (entry * marginPercent)),
              ),
            );
            expect(value.quantity, JSON.stringify({ direction, marginPercent, entry, fees })).toBe(
              expected,
            );
            expect(value.stopFeesPaise).toBe(feePaise);
            expect(value.targetFeesPaise).toBe(feePaise);
            if (expected > 0) {
              expect(value.exceedsRiskBudget).toBe(false);
              expect(value.exceedsCapital).toBe(false);
            }
          }
        }
      }
    }
  });

  it.each([
    ['100', '₹100.00'],
    ['100.0001', '₹100.0001'],
    ['1e-4', '₹0.0001'],
    ['90071992547409.91', '₹9,00,71,99,25,47,409.91'],
    ['1e309', '—'],
  ])('formats accepted prices exactly: %s', (value, expected) => {
    expect(formatPlanningPrice(value)).toBe(expected);
  });
});
