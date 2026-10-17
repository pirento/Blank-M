/**
 * A member's account settings: planning capital, equity and F&O charge rates
 * and risk limits. Stored rows are normalised so missing or invalid fields
 * fall back to defaults.
 */
import { z } from 'zod';
import { AccountSettings } from '../../models/index.js';
import { DEFAULT_ACCOUNT_SETTINGS, DEFAULT_CHARGES } from '../../shared/types.js';
import { parseRiskLimits, toRiskLimits } from '../../shared/risk-limits.js';
import { DEFAULT_FO_CHARGES } from '../../shared/segments.js';
import { HttpError } from '../errors.js';

/** Stored numbers can arrive as strings in some paths; normalise. */
function num(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Stored charge rates with every missing or invalid field taken from `defaults`. */
function chargeRates(value, defaults) {
  const raw = typeof value === 'object' && value !== null ? value : {};
  return {
    enabled: raw.enabled !== false,
    brokeragePercent: num(raw.brokeragePercent, defaults.brokeragePercent),
    brokerageMaxPerOrder: num(raw.brokerageMaxPerOrder, defaults.brokerageMaxPerOrder),
    sttPercent: num(raw.sttPercent, defaults.sttPercent),
    exchangeTxnPercent: num(raw.exchangeTxnPercent, defaults.exchangeTxnPercent),
    sebiPercent: num(raw.sebiPercent, defaults.sebiPercent),
    gstPercent: num(raw.gstPercent, defaults.gstPercent),
    stampDutyPercent: num(raw.stampDutyPercent, defaults.stampDutyPercent),
  };
}

/**
 * The member's account settings with every missing or invalid field filled from defaults (all
 * defaults when `row` is empty).
 */
export function toAccountSettings(row) {
  const fo = typeof row?.foCharges === 'object' && row.foCharges !== null ? row.foCharges : {};
  return {
    openingBalance: row
      ? num(row.openingBalance, DEFAULT_ACCOUNT_SETTINGS.openingBalance)
      : DEFAULT_ACCOUNT_SETTINGS.openingBalance,
    charges: row ? chargeRates(row.charges, DEFAULT_CHARGES) : DEFAULT_ACCOUNT_SETTINGS.charges,
    foCharges: {
      futures: chargeRates(fo.futures, DEFAULT_FO_CHARGES.futures),
      options: chargeRates(fo.options, DEFAULT_FO_CHARGES.options),
    },
    riskLimits: toRiskLimits(row?.riskLimits),
  };
}

/** The member's stored account settings, normalised by toAccountSettings. */
export async function loadAccountSettings(userId) {
  return toAccountSettings(await AccountSettings.findById(userId).lean());
}

const chargeSchema = z
  .object({
    enabled: z.boolean(),
    brokeragePercent: z.number().finite().nonnegative(),
    brokerageMaxPerOrder: z.number().finite().nonnegative(),
    sttPercent: z.number().finite().nonnegative(),
    exchangeTxnPercent: z.number().finite().nonnegative(),
    sebiPercent: z.number().finite().nonnegative(),
    gstPercent: z.number().finite().nonnegative(),
    stampDutyPercent: z.number().finite().nonnegative(),
  })
  .strict();

/**
 * Validates and applies a partial update (opening balance, equity and F&O charge rates, risk
 * limits) on top of the current settings, upserts the result and returns it. Throws HttpError 400
 * for invalid values.
 */
export async function saveAccountSettings(userId, changes) {
  const current = await loadAccountSettings(userId);
  const next = { ...current };
  if (changes.openingBalance !== undefined) {
    const value = Number(changes.openingBalance);
    if (!Number.isFinite(value) || value < 0 || value >= 1e14) {
      throw new HttpError('Opening balance must be zero or a positive amount.', 400);
    }
    next.openingBalance = Math.round(value * 100) / 100;
  }
  if (changes.charges !== undefined) {
    const parsed = chargeSchema.safeParse(changes.charges);
    if (!parsed.success) throw new HttpError('Charge rates must be non-negative numbers.', 400);
    next.charges = parsed.data;
  }
  if (changes.foCharges !== undefined) {
    const foCharges = { ...current.foCharges };
    for (const segment of ['futures', 'options']) {
      if (changes.foCharges?.[segment] === undefined) continue;
      const parsed = chargeSchema.safeParse(changes.foCharges[segment]);
      if (!parsed.success) throw new HttpError('Charge rates must be non-negative numbers.', 400);
      foCharges[segment] = parsed.data;
    }
    next.foCharges = foCharges;
  }
  if (changes.riskLimits !== undefined) {
    const { values, errors } = parseRiskLimits(changes.riskLimits ?? {});
    const problem = Object.values(errors)[0];
    if (problem) throw new HttpError(problem, 400);
    next.riskLimits = values;
  }
  await AccountSettings.updateOne(
    { _id: userId },
    {
      $set: {
        openingBalance: next.openingBalance,
        charges: next.charges,
        foCharges: next.foCharges,
        riskLimits: next.riskLimits,
      },
    },
    { upsert: true },
  );
  return next;
}
