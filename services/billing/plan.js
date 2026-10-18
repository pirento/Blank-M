/**
 * The Premium plan the administrator sets in the admin panel → Plans & billing:
 * whether billing is on, the monthly price, the free trial length, which
 * features need Premium, and whether anyone may sign up. Stored as one
 * PlatformSetting document ("billing.plan").
 *
 * With billing off (the default) every member has every feature, exactly as
 * before, so turning billing on is a deliberate step.
 */
import { AdminAuditLog, PlatformSetting } from '../../models/index.js';
import { HttpError } from '../errors.js';

const PLAN_KEY = 'billing.plan';
const CACHE_MS = 15_000;

/** Features an administrator can put behind Premium. Keys are used by requirePremium(). */
export const PREMIUM_FEATURES = [
  { key: 'ai', label: 'AI chat, coach, research and the pre-market plan' },
  {
    key: 'brokers',
    label:
      'Broker connections (Zerodha, Dhan, Upstox, Fyers, Angel One) and the daily automatic journal',
  },
  { key: 'liveOrders', label: 'Live orders with automatic stop-loss and target' },
  { key: 'livePrices', label: 'Live Zerodha prices' },
  { key: 'telegram', label: 'Telegram bot and alerts' },
  { key: 'backtest', label: 'Backtesting' },
  { key: 'paper', label: 'Paper trading' },
  { key: 'reports', label: 'Reports, tax report and the weekly email' },
  { key: 'options', label: 'Options payoff and Greeks' },
];
export const FEATURE_KEYS = PREMIUM_FEATURES.map((feature) => feature.key);
export const featureLabel = (key) =>
  PREMIUM_FEATURES.find((feature) => feature.key === key)?.label ?? key;

export const DEFAULT_PLAN = Object.freeze({
  enabled: false,
  name: 'Premium',
  priceMonthly: 499,
  trialDays: 14,
  features: FEATURE_KEYS,
  signupOpen: false,
  /** Razorpay plan created for the current price (Razorpay plans cannot change price). */
  razorpayPlanId: null,
  razorpayPlanPrice: null,
});

let cache = null;

/** The current plan with defaults for missing fields (cached for a few seconds). */
export async function loadPlan() {
  if (cache && cache.at > Date.now() - CACHE_MS) return cache.plan;
  const row = await PlatformSetting.findById(PLAN_KEY).lean();
  const stored = row?.value && typeof row.value === 'object' ? row.value : {};
  const plan = {
    ...DEFAULT_PLAN,
    ...stored,
    features: Array.isArray(stored.features)
      ? stored.features.filter((key) => FEATURE_KEYS.includes(key))
      : DEFAULT_PLAN.features,
  };
  cache = { at: Date.now(), plan };
  return plan;
}

/** Forget the cached plan (after a save, and in tests). */
export function forgetPlanCache() {
  cache = null;
}

async function writePlan(plan, actorId) {
  await PlatformSetting.updateOne(
    { _id: PLAN_KEY },
    { $set: { value: plan, updatedBy: actorId ?? null } },
    { upsert: true },
  );
  forgetPlanCache();
}

/**
 * Validates and saves the administrator's plan changes; returns the new plan.
 * Changing the price makes the next checkout create a new Razorpay plan
 * (existing subscribers stay on the price they signed up at).
 */
export async function savePlan(actor, changes) {
  const current = await loadPlan();
  const next = { ...current };
  if (changes.enabled !== undefined) next.enabled = changes.enabled === true;
  if (changes.signupOpen !== undefined) next.signupOpen = changes.signupOpen === true;
  if (changes.name !== undefined) {
    const name = String(changes.name).trim();
    if (!name || name.length > 40) throw new HttpError('Plan name must be 1–40 characters.', 400);
    next.name = name;
  }
  if (changes.priceMonthly !== undefined) {
    const price = Number(changes.priceMonthly);
    // Razorpay's smallest charge is ₹1; whole rupees keep invoices simple.
    if (!Number.isInteger(price) || price < 1 || price > 100_000) {
      throw new HttpError(
        'Monthly price must be a whole number of rupees from 1 to 1,00,000.',
        400,
      );
    }
    next.priceMonthly = price;
  }
  if (changes.trialDays !== undefined) {
    const days = Number(changes.trialDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      throw new HttpError('Free trial must be 0–365 days.', 400);
    }
    next.trialDays = days;
  }
  if (changes.features !== undefined) {
    if (
      !Array.isArray(changes.features) ||
      changes.features.some((key) => !FEATURE_KEYS.includes(key))
    ) {
      throw new HttpError('Choose Premium features from the list.', 400);
    }
    next.features = [...new Set(changes.features)];
  }
  await writePlan(next, actor.id);
  await AdminAuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'billing.plan',
    target: PLAN_KEY,
    details: {
      enabled: next.enabled,
      priceMonthly: next.priceMonthly,
      trialDays: next.trialDays,
      features: next.features,
      signupOpen: next.signupOpen,
    },
  });
  return next;
}

/**
 * Remembers the Razorpay plan created for the current price. Only these two fields
 * are written, so a stale cached plan on another process cannot undo an admin change.
 */
export async function rememberRazorpayPlan(planId, price) {
  await PlatformSetting.updateOne(
    { _id: PLAN_KEY },
    { $set: { 'value.razorpayPlanId': planId, 'value.razorpayPlanPrice': price } },
    { upsert: true },
  );
  forgetPlanCache();
}

/** What members may see about the plan (no Razorpay ids). */
export function publicPlan(plan) {
  return {
    enabled: plan.enabled,
    name: plan.name,
    priceMonthly: plan.priceMonthly,
    trialDays: plan.trialDays,
    features: plan.features.map((key) => ({ key, label: featureLabel(key) })),
    signupOpen: plan.signupOpen,
  };
}
