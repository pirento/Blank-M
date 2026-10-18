/**
 * Razorpay Subscriptions API (https://razorpay.com/docs/api/payments/subscriptions/):
 * monthly plans, subscriptions with a hosted payment page, cancellation and
 * webhook signature checks. Keys come from the admin panel → Integrations
 * (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET).
 *
 * The member pays on Razorpay's own page (subscription.short_url), so card and
 * UPI details never touch this server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors.js';
import { createLogger, errorName } from '../logger.js';

const log = createLogger('razorpay');
const API = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 20_000;
/** Razorpay needs a fixed number of billing cycles; 120 months is "until cancelled" in practice. */
const TOTAL_CYCLES = 120;

/** Whether the key id and secret are set. */
export function isRazorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
}

async function razorpay(method, path, body) {
  if (!isRazorpayConfigured()) {
    throw new HttpError('Payments are not set up yet. Ask the administrator.', 503);
  }
  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID.trim()}:${process.env.RAZORPAY_KEY_SECRET.trim()}`,
  ).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  let payload;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    log.warn('razorpay request failed', { path, error: errorName(error) });
    throw new HttpError('Razorpay could not be reached. Try again shortly.', 504);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // Razorpay's own description is safe to show (e.g. "The api key provided is invalid").
    const reason = payload?.error?.description ?? `Razorpay returned ${response.status}.`;
    log.warn('razorpay rejected request', { path, status: response.status });
    throw new HttpError(`Payment provider: ${reason}`, response.status === 401 ? 503 : 502);
  }
  return payload;
}

/** Creates a monthly plan at `priceMonthly` rupees; returns its id. */
export async function createMonthlyPlan({ name, priceMonthly }) {
  const plan = await razorpay('POST', '/plans', {
    period: 'monthly',
    interval: 1,
    item: {
      name: `Pirento Blank ${name}`,
      amount: Math.round(priceMonthly * 100),
      currency: 'INR',
      description: `${name} — monthly`,
    },
  });
  if (!plan?.id) throw new HttpError('Razorpay did not return a plan.', 502);
  return plan.id;
}

/**
 * Creates a subscription for one member. `startAt` (a future Date) delays the
 * first charge, e.g. to the end of the free trial. Returns `{ id, shortUrl, status }`.
 */
export async function createSubscription({ planId, userId, email, startAt }) {
  const subscription = await razorpay('POST', '/subscriptions', {
    plan_id: planId,
    total_count: TOTAL_CYCLES,
    quantity: 1,
    customer_notify: 1,
    ...(startAt ? { start_at: Math.floor(startAt.getTime() / 1000) } : {}),
    notes: { userId, email },
  });
  if (!subscription?.id || !subscription.short_url) {
    throw new HttpError('Razorpay did not return a payment page.', 502);
  }
  return { id: subscription.id, shortUrl: subscription.short_url, status: subscription.status };
}

/** The current state of a subscription (the same entity webhooks carry). */
export function fetchSubscription(id) {
  return razorpay('GET', `/subscriptions/${encodeURIComponent(id)}`);
}

/** Stops renewal at the end of the paid month (the member keeps Premium until then). */
export function cancelSubscription(id) {
  return razorpay('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {
    cancel_at_cycle_end: 1,
  });
}

/**
 * Whether a webhook body really came from Razorpay: HMAC-SHA256 of the raw body
 * with the webhook secret, compared in constant time.
 */
export function validWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret || !rawBody || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
