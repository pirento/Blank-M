/**
 * Web Push notifications to the member's installed app or browser. Needs a
 * VAPID key pair (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; generate one with
 * `node scripts/generate-vapid-keys.js`). Subscriptions that the push service
 * reports as gone are deleted.
 */
import webpush from 'web-push';
import { PushSubscription } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { createLogger } from '../logger.js';

const log = createLogger('push');
export const MAX_DEVICES = 10;

/** Whether both VAPID keys are set. */
export function isPushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());
}

/** The VAPID public key browsers subscribe with, or null when push is not configured. */
export function pushPublicKey() {
  return isPushConfigured() ? process.env.VAPID_PUBLIC_KEY.trim() : null;
}

function vapid() {
  const subject =
    process.env.VAPID_SUBJECT?.trim() ||
    (process.env.SMTP_FROM ? `mailto:${process.env.SMTP_FROM.replace(/^.*<|>.*$/g, '')}` : '') ||
    process.env.APP_URL ||
    'mailto:admin@example.com';
  return {
    subject,
    publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
    privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
  };
}

const base64url = /^[A-Za-z0-9_-]+={0,2}$/;

/** Saves (or refreshes) one browser subscription for the member. */
export async function subscribe(userId, subscription) {
  if (!isPushConfigured()) throw new HttpError('Push notifications are not configured.', 503);
  const endpoint = String(subscription?.endpoint ?? '');
  const keys = subscription?.keys ?? {};
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    endpoint.length > 2000 ||
    !base64url.test(String(keys.p256dh ?? '')) ||
    !base64url.test(String(keys.auth ?? ''))
  ) {
    throw new HttpError('This browser returned an invalid push subscription.', 400);
  }
  const existing = await PushSubscription.findOne({ endpoint }).lean();
  if (!existing && (await PushSubscription.countDocuments({ userId })) >= MAX_DEVICES) {
    throw new HttpError(`Notifications can be on for at most ${MAX_DEVICES} devices.`, 409);
  }
  // An endpoint belongs to one browser; re-subscribing moves it to the current member.
  await PushSubscription.updateOne(
    { endpoint },
    {
      $set: {
        userId,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      },
    },
    { upsert: true },
  );
}

/** Removes the member's subscription for `endpoint`, if any. */
export async function unsubscribe(userId, endpoint) {
  await PushSubscription.deleteOne({ userId, endpoint: String(endpoint ?? '') });
}

/** Number of devices the member has push notifications on for. */
export async function deviceCount(userId) {
  return PushSubscription.countDocuments({ userId });
}

/**
 * Sends one notification ({ title, body, url, tag }) to every device of the
 * member. Returns how many devices accepted it.
 */
export async function sendPush(userId, notification) {
  if (!isPushConfigured()) return 0;
  const subscriptions = await PushSubscription.find({ userId }).lean();
  const payload = JSON.stringify(notification);
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        // One slow push service must not stall a whole alert run.
        { vapidDetails: vapid(), TTL: 3600, timeout: 10_000 },
      );
      delivered += 1;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: subscription._id });
      } else {
        log.warn('push delivery failed', { status: error?.statusCode });
      }
    }
  }
  return delivered;
}
