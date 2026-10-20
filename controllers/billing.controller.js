/**
 * Member billing endpoints (the Billing page) and the Razorpay webhook.
 * The member never sends prices or dates: the server decides them from the plan
 * and from what Razorpay reports.
 */
import { loadPlan, publicPlan } from '../services/billing/plan.js';
import { membershipFor } from '../services/billing/membership.js';
import { isRazorpayConfigured } from '../services/billing/razorpay.js';
import { freeUsage } from '../services/billing/usage.js';
import {
  cancelMembership,
  handleWebhook,
  paymentHistory,
  refreshFromRazorpay,
  startCheckout,
} from '../services/billing/subscriptions.js';
import { HttpError } from '../services/errors.js';

/**
 * GET /api/billing: the plan, the member's Premium status, their payments and this month's use of
 * the free allowances (`freeUsage: { feature: { used, limit } }`).
 */
export async function status(req, res) {
  const plan = await loadPlan();
  const [membership, payments, usage] = await Promise.all([
    membershipFor(req.member.user),
    paymentHistory(req.member.userId),
    freeUsage(req.member.userId, plan.freeQuota),
  ]);
  res.json({
    plan: publicPlan(plan),
    membership,
    payments,
    freeUsage: usage,
    paymentsAvailable: isRazorpayConfigured(),
  });
}

/** POST /api/billing/checkout: `{ url }` of Razorpay's payment page for this member. */
export async function checkout(req, res) {
  res.json(await startCheckout(req.member.user));
}

/** POST /api/billing/refresh: re-reads the subscription from Razorpay (after paying). */
export async function refresh(req, res) {
  res.json({ membership: await refreshFromRazorpay(req.member.user) });
}

/** POST /api/billing/cancel: stop renewing; Premium continues to the end of the paid month. */
export async function cancel(req, res) {
  res.json({ membership: await cancelMembership(req.member.user) });
}

/**
 * POST /api/billing/razorpay/webhook: Razorpay subscription and payment events.
 * Authenticated by the HMAC signature over the raw body (captured in app.js),
 * not by a session, so it is exempt from CSRF.
 */
export async function webhook(req, res) {
  if (!req.rawBody) throw new HttpError('Send the webhook as JSON.', 400);
  res.json(await handleWebhook(req.rawBody, req.headers));
}
