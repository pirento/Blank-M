/**
 * Does this member have Premium right now? Worked out on each request from the
 * Subscription dates (trial end, paid-until, admin grant), so expiry needs no
 * scheduled job. Also the Express guard that puts a feature behind Premium.
 *
 *   billing off            → everyone has everything (state "billing-off")
 *   administrator          → always Premium (state "admin")
 *   admin grant running    → Premium ("granted")
 *   paid period running    → Premium ("active", or "cancelled" when it will not renew)
 *   trial running          → Premium ("trial")
 *   otherwise              → free features only ("free")
 */
import { Subscription, TrialClaim } from '../../models/index.js';
import { sha256Hex } from '../crypto.js';
import { HttpError } from '../errors.js';
import { featureLabel, loadPlan } from './plan.js';
import { takeFreeUse, usedThisMonth } from './usage.js';

const DAY_MS = 24 * 60 * 60_000;
// Razorpay charges a renewal (and sends its webhook) some time after the paid month ends.
// A renewing member keeps Premium this long past paidUntil so nothing stops in between.
const RENEWAL_GRACE_MS = 2 * DAY_MS;
const iso = (date) => (date ? new Date(date).toISOString() : null);
const later = (date, now) => Boolean(date && new Date(date).getTime() > now);

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address a mailbox really is, so aliases count as one person: lower case, without a
 * "+tag", and for Gmail without dots (a.b+x@gmail.com and ab@gmail.com are the same inbox).
 */
export function canonicalEmail(email) {
  const [local = '', domain = ''] = String(email).trim().toLowerCase().split('@');
  const name = local.split('+')[0];
  return GMAIL_DOMAINS.has(domain) ? `${name.replaceAll('.', '')}@gmail.com` : `${name}@${domain}`;
}

/**
 * Records this member's free trial; false when the same person (canonical email) already had
 * one, e.g. under an alias or an account deleted since.
 */
async function claimTrial(user) {
  const _id = sha256Hex(`trial\0${canonicalEmail(user.email)}`);
  try {
    await TrialClaim.create({ _id, userId: user._id });
    return true;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return Boolean(await TrialClaim.exists({ _id, userId: user._id }));
  }
}

/**
 * The member's Subscription row, created on first sight with the trial starting
 * now (so members who existed before billing was switched on get a full trial).
 * Only one trial per person: an alias of an address that already had one starts free.
 */
async function subscriptionFor(user, plan, now) {
  const existing = await Subscription.findById(user._id).lean();
  if (existing) return existing;
  const trialEndsAt =
    plan.trialDays > 0 && (await claimTrial(user)) ? new Date(now + plan.trialDays * DAY_MS) : null;
  try {
    await Subscription.create({ _id: user._id, trialEndsAt });
  } catch (error) {
    // Created by a parallel request: read theirs.
    if (error?.code !== 11000) throw error;
  }
  return Subscription.findById(user._id).lean();
}

/**
 * Premium status from a plan and a Subscription row (pure; `sub` may be null when
 * the member has not been seen since billing was switched on).
 */
export function computeMembership(plan, user, sub, now = Date.now()) {
  const base = { billingEnabled: plan.enabled, premiumFeatures: plan.features };
  if (!plan.enabled) return { ...base, premium: true, state: 'billing-off', daysLeft: null };
  if (user.role === 'admin') return { ...base, premium: true, state: 'admin', daysLeft: null };
  const dates = {
    trialEndsAt: iso(sub?.trialEndsAt),
    paidUntil: iso(sub?.paidUntil),
    grantUntil: iso(sub?.grantUntil),
    razorpayStatus: sub?.razorpayStatus ?? null,
    cancelAtPeriodEnd: Boolean(sub?.cancelAtPeriodEnd),
  };
  const renewing = ['active', 'pending'].includes(sub?.razorpayStatus) && !sub?.cancelAtPeriodEnd;
  const paidEnds =
    sub?.paidUntil && renewing
      ? new Date(new Date(sub.paidUntil).getTime() + RENEWAL_GRACE_MS)
      : sub?.paidUntil;
  // The latest of the three dates is when Premium ends.
  const ends = [sub?.grantUntil, paidEnds, sub?.trialEndsAt]
    .filter((date) => later(date, now))
    .map((date) => new Date(date).getTime());
  const endsAt = ends.length ? Math.max(...ends) : null;
  const state = later(sub?.grantUntil, now)
    ? 'granted'
    : later(paidEnds, now)
      ? sub.cancelAtPeriodEnd
        ? 'cancelled'
        : 'active'
      : later(sub?.trialEndsAt, now)
        ? 'trial'
        : sub
          ? 'free'
          : 'not-started';
  return {
    ...base,
    ...dates,
    premium: endsAt !== null,
    state,
    premiumEndsAt: endsAt ? new Date(endsAt).toISOString() : null,
    daysLeft: endsAt ? Math.ceil((endsAt - now) / DAY_MS) : 0,
  };
}

/**
 * The member's Premium status for the UI and for guards:
 * `{ billingEnabled, premium, state, trialEndsAt, paidUntil, grantUntil, daysLeft, premiumFeatures }`.
 * The first time a member is seen with billing on, their free trial starts.
 */
export async function membershipFor(user, now = Date.now()) {
  const plan = await loadPlan();
  if (!plan.enabled || user.role === 'admin') return computeMembership(plan, user, null, now);
  return computeMembership(plan, user, await subscriptionFor(user, plan, now), now);
}

/** Whether the member may use a feature now (free features and billing-off always may). */
export async function hasFeature(user, feature) {
  const plan = await loadPlan();
  if (!plan.enabled || !plan.features.includes(feature)) return true;
  return (await membershipFor(user)).premium;
}

/**
 * Whether a free member may still open a Premium feature's page: Premium, a free feature, or
 * free uses left this month (opening the page does not use one; its requests do).
 */
export async function canUseFeature(user, feature) {
  if (await hasFeature(user, feature)) return true;
  const limit = (await loadPlan()).freeQuota[feature] ?? 0;
  return limit > 0 && (await usedThisMonth(user._id, feature)) < limit;
}

/** The 402 error shown when a free member opens a Premium feature (`limit`: free uses used up). */
export function premiumRequired(feature, limit = 0) {
  const why = limit
    ? `You have used this month's ${limit} free uses of ${featureLabel(feature)}.`
    : `${featureLabel(feature)} is part of Premium.`;
  return new HttpError(`${why} Start or renew Premium in Billing.`, 402, {
    code: 'premium_required',
    feature,
  });
}

/**
 * Express guard for API routes: lets the request through when the signed-in member
 * may use `feature` (Premium, or one of this month's free uses); answers 402 otherwise. Signed-out requests pass through so the
 * route's own sign-in check answers them as before.
 */
export function requirePremium(feature) {
  return async (req, _res, next) => {
    try {
      const user = req.member?.user ?? req.auth?.user;
      if (user && !req.auth?.accessError && !(await hasFeature(user, feature))) {
        // A free member may use the feature a few times a month before Premium is needed.
        const limit = (await loadPlan()).freeQuota[feature] ?? 0;
        if (!(await takeFreeUse(user._id, feature, limit))) throw premiumRequired(feature, limit);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
