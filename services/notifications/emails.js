/**
 * Emails every member gets without asking: a welcome when the account is
 * activated, billing emails (payment received, payment failed, renewal stopped,
 * trial ending soon). A failed email is logged and never breaks the action that
 * triggered it (a webhook, an activation). Administrator announcements live in
 * services/admin/announcements.js.
 */
import { AccountSettings, Subscription, User } from '../../models/index.js';
import { loadPlan } from '../billing/plan.js';
import { createLogger, errorName } from '../logger.js';
import { isMailConfigured, sendMail } from '../mailer.js';

const log = createLogger('emails');
const DAY_MS = 24 * 60 * 60_000;

const origin = () => {
  try {
    return new URL(process.env.APP_URL || '').origin;
  } catch {
    return '';
  }
};
const rupees = (amount) => `₹${Number(amount).toLocaleString('en-IN')}`;
const day = (date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(
    new Date(date),
  );

/** Sends one email if mail is set up; returns whether it went. Never throws. */
export async function sendQuietly(to, subject, lines) {
  if (!isMailConfigured() || !to) return false;
  try {
    await sendMail({ to, subject, text: lines.filter((line) => line !== null).join('\n') });
    return true;
  } catch (error) {
    log.warn('email not sent', { subject, error: errorName(error) });
    return false;
  }
}

/**
 * A member's account was just activated: turn the weekly report on for them (they can turn it off
 * in Settings) and send a welcome email.
 */
export async function welcomeMember(user) {
  await AccountSettings.updateOne(
    { _id: user._id },
    { $setOnInsert: { weeklyReportEmail: true } },
    { upsert: true },
  );
  const plan = await loadPlan();
  const link = origin();
  return sendQuietly(user.email, 'Welcome to Pirento Blank', [
    'Welcome to Pirento Blank, your trading journal.',
    '',
    'A good first hour:',
    '- Settings: set your capital and your broker charges.',
    '- Import: bring in your broker trade book, or add trades by hand.',
    '- Rules: write the few rules you want to trade by.',
    plan.enabled && plan.trialDays > 0
      ? `\nYour ${plan.trialDays}-day free trial of ${plan.name} has started.`
      : null,
    '',
    link ? `Open your workspace: ${link}/dashboard` : null,
    'You will get a short weekly report every Monday; turn it off in Settings → Email reports.',
    '',
    'Pirento Blank is a journal and planning tool, not investment advice.',
  ]);
}

/**
 * The email for a Razorpay event that matters to the member, or null for the others. `record` is
 * the member's Subscription after the event was applied.
 */
export async function billingEventEmail(event, record) {
  if (!record?._id) return false;
  const user = await User.findById(record._id, { email: 1 }).lean();
  if (!user) return false;
  const plan = await loadPlan();
  const payment = event.payload?.payment?.entity;
  const billingLink = origin() ? `${origin()}/billing` : null;
  switch (event.event) {
    case 'subscription.charged':
      return sendQuietly(user.email, `Payment received — ${plan.name}`, [
        `We received your payment${payment?.amount ? ` of ${rupees(payment.amount / 100)}` : ''}.`,
        record.paidUntil ? `${plan.name} is active until ${day(record.paidUntil)}.` : null,
        '',
        billingLink ? `Your payments: ${billingLink}` : null,
      ]);
    case 'payment.failed':
      return sendQuietly(user.email, `Your ${plan.name} payment did not go through`, [
        'Your bank or card declined this month’s payment. Razorpay will try again over the next few days.',
        'Make sure the card or UPI mandate is active, or subscribe again with another method.',
        '',
        billingLink ? `Billing: ${billingLink}` : null,
      ]);
    case 'subscription.cancelled':
      return sendQuietly(user.email, `${plan.name} will not renew`, [
        record.paidUntil && new Date(record.paidUntil) > new Date()
          ? `Your subscription is cancelled. You keep ${plan.name} until ${day(record.paidUntil)}.`
          : `Your ${plan.name} subscription is cancelled.`,
        'You can subscribe again at any time.',
        '',
        billingLink ? `Billing: ${billingLink}` : null,
      ]);
    default:
      return false;
  }
}

/**
 * Daily job: tells members whose free trial ends within 3 days (and who have not subscribed) that
 * it is ending, once per trial. Returns how many emails were sent.
 */
export async function sendTrialReminders(now = new Date(), limit = 500) {
  const plan = await loadPlan();
  if (!plan.enabled || !isMailConfigured()) return 0;
  const due = await Subscription.find({
    trialEndsAt: { $gt: now, $lte: new Date(now.getTime() + 3 * DAY_MS) },
    trialReminderSentAt: null,
    razorpayStatus: { $nin: ['created', 'authenticated', 'active', 'pending'] },
  })
    .limit(limit)
    .lean();
  let sent = 0;
  for (const sub of due) {
    // Claim first so two runs never email twice.
    const claim = await Subscription.updateOne(
      { _id: sub._id, trialReminderSentAt: null },
      { $set: { trialReminderSentAt: now } },
    );
    if (!claim.modifiedCount) continue;
    const user = await User.findById(sub._id, { email: 1, status: 1 }).lean();
    if (!user || user.status !== 'active') continue;
    const ok = await sendQuietly(
      user.email,
      `Your ${plan.name} trial ends on ${day(sub.trialEndsAt)}`,
      [
        `Your free trial of ${plan.name} ends on ${day(sub.trialEndsAt)}.`,
        `Keep everything for ${rupees(plan.priceMonthly)} a month; cancel any time.`,
        '',
        origin() ? `Subscribe: ${origin()}/billing` : null,
      ],
    );
    if (ok) sent += 1;
  }
  return sent;
}
