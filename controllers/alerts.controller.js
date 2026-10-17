/**
 * Price alerts and push notification endpoints: manage alerts, check them now,
 * and subscribe this browser to push notifications (or send a test).
 */
import * as alerts from '../services/notifications/price-alerts.js';
import * as push from '../services/notifications/push.js';
import { isMailConfigured } from '../services/mailer.js';
import { HttpError } from '../services/errors.js';

/** GET /api/alerts: the member's price alerts and which delivery channels the server supports. */
export async function list(req, res) {
  res.json({
    alerts: await alerts.listAlerts(req.member.userId),
    channels: { push: push.isPushConfigured(), email: isMailConfigured() },
  });
}

/** POST /api/alerts: creates a price alert (201). */
export async function create(req, res) {
  res.status(201).json({ alert: await alerts.createAlert(req.member.userId, req.body) });
}

/** DELETE /api/alerts/:id: deletes one of the member's alerts (404 when not found). */
export async function remove(req, res) {
  await alerts.deleteAlert(req.member.userId, req.params.id);
  res.json({ ok: true });
}

/** POST /api/alerts/:id/reactivate: re-arms a triggered alert at the same level. */
export async function reactivate(req, res) {
  res.json({ alert: await alerts.reactivateAlert(req.member.userId, req.params.id) });
}

/** POST /api/alerts/check: checks the member's active alerts now. */
export async function check(req, res) {
  res.json(await alerts.checkMemberAlerts(req.member.userId));
}

/* ------------------------------------- push ------------------------------------- */

/** GET /api/push: whether push is set up on the server, its public VAPID key and this member's device count. */
export async function pushConfig(req, res) {
  res.json({
    configured: push.isPushConfigured(),
    publicKey: push.pushPublicKey(),
    devices: await push.deviceCount(req.member.userId),
  });
}

/** POST /api/push/subscribe { subscription }: saves this browser for push; returns the device count. */
export async function pushSubscribe(req, res) {
  await push.subscribe(req.member.userId, req.body?.subscription, req.get('user-agent') ?? '');
  res.status(201).json({ devices: await push.deviceCount(req.member.userId) });
}

/** POST /api/push/unsubscribe { endpoint }: removes one browser; returns the device count. */
export async function pushUnsubscribe(req, res) {
  await push.unsubscribe(req.member.userId, req.body?.endpoint);
  res.json({ devices: await push.deviceCount(req.member.userId) });
}

/** POST /api/push/test: sends a test notification to every device; 409 when none accepted it. */
export async function pushTest(req, res) {
  const delivered = await push.sendPush(req.member.userId, {
    title: 'Blank notifications are on',
    body: 'Price alerts will appear like this.',
    url: '/watchlist',
    tag: 'push-test',
  });
  if (!delivered) throw new HttpError('No device accepted the test notification.', 409);
  res.json({ delivered });
}
