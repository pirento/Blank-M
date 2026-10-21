/**
 * Premium subscriptions end to end:
 *
 *   member clicks Subscribe → startCheckout() creates a Razorpay subscription
 *   (first charge after the trial, if one is running) → member pays on
 *   Razorpay's page → Razorpay calls our webhook → handleWebhook() records the
 *   payment and moves paidUntil to the end of the paid month.
 *
 * Every month Razorpay charges again and sends another webhook. If a charge
 * fails Razorpay retries; Premium simply ends when paidUntil passes. The
 * administrator can also grant Premium days by hand.
 */
import { AdminAuditLog, BillingEvent, Payment, Subscription, User } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { createLogger } from '../logger.js';
import { computeMembership, membershipFor } from './membership.js';
import { billingEventEmail } from '../notifications/emails.js';
import { loadPlan, rememberRazorpayPlan } from './plan.js';
import {
  cancelSubscription,
  createMonthlyPlan,
  createSubscription,
  fetchSubscription,
  isRazorpayConfigured,
  validWebhookSignature,
} from './razorpay.js';

const log = createLogger('billing');
const DAY_MS = 24 * 60 * 60_000;
/** Statuses where the Razorpay subscription is still alive (paying or about to). */
const LIVE_STATUSES = ['created', 'authenticated', 'active', 'pending'];
// Renewals that failed (halted/paused) can still charge when an old invoice is paid; cancel those too.
const CANCELLABLE_STATUSES = [...LIVE_STATUSES, 'halted', 'paused'];

/**
 * The Razorpay plan for the current price, created on first use, after a price change or after
 * the Razorpay keys change account (test → live).
 */
async function currentRazorpayPlan(plan) {
  const keyId = process.env.RAZORPAY_KEY_ID ?? null;
  if (
    plan.razorpayPlanId &&
    plan.razorpayPlanPrice === plan.priceMonthly &&
    // Plans saved before the key was recorded are kept; a different key (test → live) is not.
    (plan.razorpayPlanKeyId ?? keyId) === keyId
  ) {
    return plan.razorpayPlanId;
  }
  const id = await createMonthlyPlan(plan);
  await rememberRazorpayPlan(id, plan.priceMonthly, keyId);
  return id;
}

/**
 * Starts (or resumes) checkout for a member; returns `{ url }` of Razorpay's
 * payment page. A subscription already created but not paid is reused.
 */
export async function startCheckout(user) {
  const plan = await loadPlan();
  if (!plan.enabled) throw new HttpError('Billing is not switched on.', 409);
  if (!isRazorpayConfigured()) {
    throw new HttpError('Payments are not set up yet. Ask the administrator.', 503);
  }
  const membership = await membershipFor(user);
  // Claim the record so two quick clicks cannot create two Razorpay subscriptions.
  // A claim left behind by a crash is taken over after two minutes.
  const claimed = await Subscription.findOneAndUpdate(
    {
      _id: user._id,
      $or: [
        { razorpayStatus: { $nin: [...LIVE_STATUSES, 'creating'] } },
        { razorpayStatus: 'creating', updatedAt: { $lt: new Date(Date.now() - 2 * 60_000) } },
      ],
    },
    { $set: { razorpayStatus: 'creating' } },
  ).lean();
  if (!claimed) {
    const sub = await Subscription.findById(user._id).lean();
    if (sub?.razorpayStatus === 'created' && sub.checkoutUrl) return { url: sub.checkoutUrl };
    if (sub?.razorpayStatus === 'creating') {
      throw new HttpError('Your payment page is being prepared. Try again in a moment.', 409);
    }
    throw new HttpError('You already have a subscription. It renews every month.', 409);
  }
  try {
    // A halted subscription can come back to life when an old invoice is paid;
    // end it before starting a new one so the member is never charged twice.
    if (claimed.razorpaySubscriptionId && ['halted', 'paused'].includes(claimed.razorpayStatus)) {
      // If it cannot be cancelled and is still alive, stop: a second one could charge twice.
      await cancelSubscription(claimed.razorpaySubscriptionId, { immediately: true }).catch(
        async (error) => {
          const old = await fetchSubscription(claimed.razorpaySubscriptionId);
          if (CANCELLABLE_STATUSES.includes(old?.status)) throw error;
        },
      );
    }
    const planId = await currentRazorpayPlan(plan);
    // Do not charge while Premium is still running (trial, admin grant or an earlier paid month):
    // the first charge is on the day it ends.
    const ends = [membership.trialEndsAt, membership.grantUntil, membership.paidUntil]
      .filter(Boolean)
      .map((date) => new Date(date).getTime());
    const premiumEnds = ends.length ? Math.max(...ends) : 0;
    const startAt = premiumEnds > Date.now() + 10 * 60_000 ? new Date(premiumEnds) : null;
    const created = await createSubscription({
      planId,
      userId: user._id,
      email: user.email,
      startAt,
    });
    await Subscription.updateOne(
      { _id: user._id },
      {
        $set: {
          razorpaySubscriptionId: created.id,
          razorpayStatus: created.status ?? 'created',
          checkoutUrl: created.shortUrl,
          planPrice: plan.priceMonthly,
          cancelAtPeriodEnd: false,
        },
      },
    );
    return { url: created.shortUrl };
  } catch (error) {
    // Give the claim back so the member can try again.
    await Subscription.updateOne(
      { _id: user._id, razorpayStatus: 'creating' },
      { $set: { razorpayStatus: claimed.razorpayStatus ?? null } },
    );
    throw error;
  }
}

/** Razorpay statuses after which a subscription never becomes live again. */
const FINAL_STATUSES = ['cancelled', 'completed', 'expired'];
/**
 * Statuses whose current_end is a period that has really been paid for. Not "cancelled": a
 * subscription cancelled while a charge was failing carries the unpaid cycle; a normal
 * cancellation's paid month was already recorded while it was active.
 */
const PAID_STATUSES = ['active', 'completed'];

/**
 * Applies a Razorpay subscription entity (from a webhook or a fetch) to our record.
 * Webhooks can arrive late or out of order, so the paid period only ever moves
 * forward ($max) and a finished subscription is never marked live again.
 */
async function applySubscriptionEntity(entity) {
  if (!entity?.id) return null;
  const status = String(entity.status ?? '');
  const paid =
    PAID_STATUSES.includes(status) &&
    Number.isFinite(entity.current_end) &&
    entity.current_end > 0 &&
    entity.paid_count > 0;
  const update = {
    $set: {
      ...(FINAL_STATUSES.includes(status) ? { cancelAtPeriodEnd: true } : {}),
      ...(status !== 'created' ? { checkoutUrl: null } : {}),
    },
    // pending/halted carry the next, unpaid cycle; only a paid cycle extends Premium.
    ...(paid ? { $max: { paidUntil: new Date(entity.current_end * 1000) } } : {}),
  };
  const ours = await Subscription.findOne({ razorpaySubscriptionId: entity.id }).lean();
  if (ours) {
    if (!(FINAL_STATUSES.includes(ours.razorpayStatus) && !FINAL_STATUSES.includes(status))) {
      update.$set.razorpayStatus = status;
    }
    return Subscription.findOneAndUpdate({ _id: ours._id }, update, { new: true }).lean();
  }
  // A subscription created from the Razorpay dashboard: match the member from its
  // notes, but never replace a subscription we already track for them.
  const userId = entity.notes?.userId;
  if (!userId || !(await User.exists({ _id: userId }))) return null;
  update.$set.razorpayStatus = status;
  update.$set.razorpaySubscriptionId = entity.id;
  try {
    return await Subscription.findOneAndUpdate(
      { _id: userId, razorpaySubscriptionId: null },
      update,
      { upsert: true, new: true },
    ).lean();
  } catch (error) {
    // The member already has another subscription on record: leave it alone.
    if (error?.code === 11000) return null;
    throw error;
  }
}

/**
 * Handles one Razorpay webhook. Returns `{ ok, duplicate? }`; throws HttpError 400
 * for a bad signature. Each event id is applied once (Razorpay retries).
 */
export async function handleWebhook(rawBody, headers) {
  if (!validWebhookSignature(rawBody, headers['x-razorpay-signature'])) {
    throw new HttpError('Invalid webhook signature.', 400);
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError('Invalid webhook body.', 400);
  }
  const eventId = String(headers['x-razorpay-event-id'] ?? '').slice(0, 100);
  if (eventId) {
    try {
      await BillingEvent.create({ _id: eventId, type: String(event.event ?? '') });
    } catch (error) {
      if (error?.code === 11000) return { ok: true, duplicate: true };
      throw error;
    }
  }
  try {
    return await applyWebhookEvent(event);
  } catch (error) {
    // Let Razorpay's retry apply it: forget that this event id was seen.
    if (eventId) await BillingEvent.deleteOne({ _id: eventId }).catch(() => undefined);
    throw error;
  }
}

async function applyWebhookEvent(event) {
  const subscription = event.payload?.subscription?.entity;
  const record = await applySubscriptionEntity(subscription);
  const payment = event.payload?.payment?.entity;
  if (payment?.id && Number.isFinite(payment.amount)) {
    // payment.failed carries only the payment: find the member through its subscription id.
    const owner =
      record?._id ??
      subscription?.notes?.userId ??
      (payment.subscription_id
        ? (
            await Subscription.findOne(
              { razorpaySubscriptionId: payment.subscription_id },
              { _id: 1 },
            ).lean()
          )?._id
        : null) ??
      null;
    await Payment.updateOne(
      { _id: payment.id },
      {
        $set: {
          userId: owner,
          razorpaySubscriptionId: subscription?.id ?? payment.subscription_id ?? null,
          amount: payment.amount / 100,
          currency: payment.currency ?? 'INR',
          status: String(payment.status ?? 'unknown'),
          method: payment.method ?? null,
          paidAt: new Date((payment.created_at ?? Date.now() / 1000) * 1000),
        },
      },
      { upsert: true },
    );
  }
  log.info('razorpay webhook', { event: event.event, matched: Boolean(record) });
  // Each event id is applied once (handleWebhook), so the member gets one email per event. Not
  // awaited: Razorpay must get its answer quickly even when the mail server is slow.
  void billingEventEmail(event, record).catch((error) =>
    log.warn('billing email failed', { error: error?.name }),
  );
  return { ok: true };
}

/** Re-reads the member's subscription from Razorpay (after returning from the payment page). */
export async function refreshFromRazorpay(user) {
  const sub = await Subscription.findById(user._id).lean();
  if (sub?.razorpaySubscriptionId && isRazorpayConfigured()) {
    await applySubscriptionEntity(await fetchSubscription(sub.razorpaySubscriptionId));
  }
  return membershipFor(user);
}

/** The member cancels: no more renewals, Premium stays until the paid month ends. */
export async function cancelMembership(user) {
  const sub = await Subscription.findById(user._id).lean();
  if (!sub?.razorpaySubscriptionId || !CANCELLABLE_STATUSES.includes(sub.razorpayStatus)) {
    throw new HttpError('There is no active subscription to cancel.', 409);
  }
  // Before the first charge (checkout not finished, or still in the trial), or when renewals
  // already failed (halted/paused), there is no paid month to run out: cancel at once.
  const entity = await cancelSubscription(sub.razorpaySubscriptionId, {
    immediately: ['created', 'authenticated', 'halted', 'paused'].includes(sub.razorpayStatus),
  });
  await applySubscriptionEntity(entity);
  await Subscription.updateOne({ _id: user._id }, { $set: { cancelAtPeriodEnd: true } });
  return membershipFor(user);
}

/**
 * Ends a member's live Razorpay subscription at once (the administrator revoked their access, so
 * they could neither use nor cancel what they pay for). Returns true when one was cancelled.
 */
export async function endSubscriptionNow(userId) {
  const sub = await Subscription.findById(userId).lean();
  if (!sub?.razorpaySubscriptionId || !CANCELLABLE_STATUSES.includes(sub.razorpayStatus)) {
    return false;
  }
  const entity = await cancelSubscription(sub.razorpaySubscriptionId, { immediately: true });
  await applySubscriptionEntity(entity);
  await Subscription.updateOne({ _id: userId }, { $set: { cancelAtPeriodEnd: true } });
  return true;
}

/** The member's last 24 payments, newest first. */
export async function paymentHistory(userId) {
  const rows = await Payment.find({ userId }).sort({ paidAt: -1 }).limit(24).lean();
  return rows.map((row) => ({
    id: row._id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    method: row.method,
    paidAt: row.paidAt.toISOString(),
  }));
}

/**
 * Administrator: give a member `days` of Premium (added to any grant still
 * running), or end the grant with days = 0. Audited.
 */
export async function grantPremium(actor, userId, days) {
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new HttpError('Days must be a whole number from 0 to 3650.', 400);
  }
  const member = await User.findById(userId).lean();
  if (!member) throw new HttpError('Member not found.', 404);
  // Start the member's free trial first if they have never been seen, so a grant adds to it.
  await membershipFor(member);
  const sub = await Subscription.findById(userId).lean();
  const from = Math.max(Date.now(), sub?.grantUntil ? new Date(sub.grantUntil).getTime() : 0);
  const grantUntil = days === 0 ? null : new Date(from + days * DAY_MS);
  await Subscription.updateOne({ _id: userId }, { $set: { grantUntil } }, { upsert: true });
  await AdminAuditLog.create({
    actorId: actor.id,
    actorEmail: actor.email,
    action: days === 0 ? 'member.grant.end' : 'member.grant',
    target: member.email,
    details: { days, grantUntil: grantUntil?.toISOString() ?? null },
  });
  return membershipFor(member);
}

/**
 * Numbers for the admin overview: members by Premium state, monthly recurring
 * revenue from active subscriptions, and payments received in the last 30 days.
 */
export async function billingMetrics(now = Date.now()) {
  const nowDate = new Date(now);
  const [trial, paying, granted, cancelled, revenue, failed] = await Promise.all([
    Subscription.countDocuments({
      trialEndsAt: { $gt: nowDate },
      $or: [{ paidUntil: null }, { paidUntil: { $lte: nowDate } }],
    }),
    Subscription.aggregate([
      { $match: { paidUntil: { $gt: nowDate }, cancelAtPeriodEnd: false } },
      { $group: { _id: null, count: { $sum: 1 }, mrr: { $sum: { $ifNull: ['$planPrice', 0] } } } },
    ]),
    Subscription.countDocuments({ grantUntil: { $gt: nowDate } }),
    Subscription.countDocuments({ paidUntil: { $gt: nowDate }, cancelAtPeriodEnd: true }),
    Payment.aggregate([
      { $match: { status: 'captured', paidAt: { $gt: new Date(now - 30 * DAY_MS) } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.countDocuments({ status: 'failed', paidAt: { $gt: new Date(now - 30 * DAY_MS) } }),
  ]);
  return {
    onTrial: trial,
    paying: paying[0]?.count ?? 0,
    mrr: paying[0]?.mrr ?? 0,
    granted,
    cancelling: cancelled,
    revenue30d: revenue[0]?.total ?? 0,
    payments30d: revenue[0]?.count ?? 0,
    failedPayments30d: failed,
  };
}

/** Recent payments across all members for the admin billing page. */
export async function recentPayments(limit = 100) {
  const rows = await Payment.find().sort({ paidAt: -1 }).limit(limit).lean();
  const emails = new Map(
    (
      await User.find(
        { _id: { $in: rows.map((row) => row.userId).filter(Boolean) } },
        { email: 1 },
      ).lean()
    ).map((user) => [user._id, user.email]),
  );
  return rows.map((row) => ({
    id: row._id,
    email: emails.get(row.userId) ?? null,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    method: row.method,
    paidAt: row.paidAt.toISOString(),
  }));
}

/**
 * Premium state per member id for the admin members table, read in one query and
 * without starting anyone's trial (members not seen yet show "not-started").
 */
export async function membershipsByUser(users, now = Date.now()) {
  const plan = await loadPlan();
  const subs = new Map(
    (await Subscription.find({ _id: { $in: users.map((user) => user._id) } }).lean()).map((sub) => [
      sub._id,
      sub,
    ]),
  );
  return Object.fromEntries(
    users.map((user) => [user._id, computeMembership(plan, user, subs.get(user._id) ?? null, now)]),
  );
}
