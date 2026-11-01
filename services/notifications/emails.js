/**
 * Emails every member gets without asking: a welcome when the account is activated, billing
 * emails (welcome to Premium, payment received, payment failed, renewal stopped, trial ending
 * soon, trial ended, Premium ended), security notices (password changed, new sign-in, account
 * deleted) and access paused/restored. A failed email is logged and never breaks the action that
 * triggered it (a webhook, an activation). Administrator announcements live in
 * services/admin/announcements.js.
 */
import { AccountSettings, Invoice, Subscription, User } from '../../models/index.js';
import { computeMembership } from '../billing/membership.js';
import { featureLabel, loadPlan } from '../billing/plan.js';
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

const supportEmail = () => process.env.SUPPORT_EMAIL?.trim();
const dayAndTime = (date) =>
  `${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(date))} IST`;

/** Sends one email (extra `headers` optional) if mail is set up; returns whether it went. Never throws. */
export async function sendQuietly(to, subject, lines, headers) {
  if (!isMailConfigured() || !to) return false;
  try {
    const text = lines.filter((line) => line !== null).join('\n');
    await sendMail({ to, subject, text, headers });
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
  const premium = plan.enabled && plan.features.length;
  return sendQuietly(user.email, 'Welcome to Pirento Blank', [
    'Welcome to Pirento Blank. Your account is ready.',
    '',
    'Pirento Blank is your private place to plan trades, record them and review what works.',
    '',
    'A good first hour:',
    '- Settings: set your starting capital and your broker charges, so every P&L is net of costs.',
    '- Import: bring in your broker trade book, or add a trade by hand in the Journal.',
    '- Rules: write down the few rules you want to trade by.',
    '- Calculator: size your next trade and its risk before you place it.',
    premium
      ? `\n${plan.trialDays > 0 ? `Your ${plan.trialDays}-day free trial of ${plan.name} has started. It includes:` : `${plan.name} (${rupees(plan.priceMonthly)} a month, on the Billing page) adds:`}`
      : null,
    ...(premium ? plan.features.map((key) => `- ${featureLabel(key)}`) : []),
    '',
    'Every Monday you get a short weekly report by email; turn it off in Settings → Email reports.',
    '',
    `Need help? ${supportEmail() ? `Write to ${supportEmail()}, or use` : 'Use'} Settings → Report a problem.`,
    '',
    link ? `Open your workspace: ${link}/dashboard` : null,
    '',
    'Pirento Blank is a journal and planning tool, not investment advice.',
  ]);
}

/**
 * The email for a Razorpay event that matters to the member, or null for the others. `record` is
 * the member's Subscription after the event was applied.
 */
export async function billingEventEmail(event, record) {
  const payment = event.payload?.payment?.entity;
  // payment.failed carries only the payment: find the member through its subscription id.
  record ??= payment?.subscription_id
    ? await Subscription.findOne({ razorpaySubscriptionId: payment.subscription_id }).lean()
    : null;
  if (!record?._id) return false;
  // A suspended member is told about that instead (revoking cancels their renewal).
  const user = await User.findById(record._id, { email: 1, status: 1 }).lean();
  if (!user || user.status !== 'active') return false;
  const plan = await loadPlan();
  const billingLink = origin() ? `${origin()}/billing` : null;
  switch (event.event) {
    case 'subscription.charged': {
      // Issued by the webhook just before this email (missing if that failed).
      const invoice = payment?.id
        ? await Invoice.findOne({ paymentId: payment.id }, { number: 1, type: 1 }).lean()
        : null;
      const invoiceLine =
        invoice && origin()
          ? `Your ${invoice.type === 'tax-invoice' ? 'tax invoice' : 'receipt'}: ${origin()}/billing/invoices/${invoice.number}`
          : null;
      // The first charge of a subscription: a welcome instead of a plain receipt.
      if (event.payload?.subscription?.entity?.paid_count === 1) {
        return sendQuietly(user.email, `Welcome to ${plan.name}`, [
          `Thank you for subscribing. Your first payment has been received and ${plan.name} is now active.`,
          '',
          payment?.amount ? `Amount paid: ${rupees(payment.amount / 100)}` : null,
          record.paidUntil ? `Active until: ${day(record.paidUntil)}` : null,
          'Renewal: monthly, cancel any time',
          '',
          plan.features.length ? `${plan.name} includes:` : null,
          ...plan.features.map((key) => `- ${featureLabel(key)}`),
          '',
          invoiceLine,
          billingLink ? `Your payments: ${billingLink}` : null,
        ]);
      }
      return sendQuietly(user.email, `Payment received — ${plan.name}`, [
        `We received your payment${payment?.amount ? ` of ${rupees(payment.amount / 100)}` : ''}.`,
        record.paidUntil ? `${plan.name} is active until ${day(record.paidUntil)}.` : null,
        '',
        invoiceLine,
        billingLink ? `Your payments: ${billingLink}` : null,
      ]);
    }
    case 'payment.failed':
      return sendQuietly(user.email, `Your ${plan.name} payment did not go through`, [
        `We could not collect your ${plan.name} payment: your bank, card or UPI app declined it.`,
        '',
        'Razorpay will try again on its own over the next few days; you do not need to pay by hand. Your journal and data are safe either way.',
        '',
        'Worth checking:',
        '- the card has not expired and has enough limit, or the UPI mandate is still active in your UPI app;',
        '- your bank allows recurring (auto-pay) payments on it.',
        '',
        `If it keeps failing, open Billing to see your ${plan.name} status and subscribe again with another card or UPI ID.`,
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
  const ends = { $gt: now, $lte: new Date(now.getTime() + 3 * DAY_MS) };
  const due = await Subscription.find({
    trialEndsAt: ends,
    trialReminderSentAt: null,
    // Not already subscribed (an unfinished checkout, "created", still gets the reminder)...
    razorpayStatus: { $nin: ['authenticated', 'active', 'pending'] },
    // ...and Premium really ends with the trial (no admin grant or paid month after it).
    $and: [
      { $or: [{ grantUntil: null }, { grantUntil: { $lte: ends.$lte } }] },
      { $or: [{ paidUntil: null }, { paidUntil: { $lte: ends.$lte } }] },
    ],
  })
    .limit(limit)
    .lean();
  let sent = 0;
  for (const sub of due) {
    // A grant or paid month running past the trial keeps Premium on: no "trial ends" email.
    const trialEnd = new Date(sub.trialEndsAt).getTime();
    if ([sub.grantUntil, sub.paidUntil].some((date) => date && new Date(date).getTime() > trialEnd))
      continue;
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
    // Not sent (mail server down): try again on the next run.
    else await Subscription.updateOne({ _id: sub._id }, { $set: { trialReminderSentAt: null } });
  }
  return sent;
}

/** Ended Premium is reported for this long; older endings (e.g. before the job ran) are skipped. */
const ENDED_WINDOW_MS = 3 * DAY_MS;

/**
 * Daily job: tells members whose free trial ended in the last 3 days, and who never subscribed,
 * that it has ended, once per trial. Returns how many emails were sent.
 */
export async function sendTrialEndedEmails(now = new Date(), limit = 500) {
  const plan = await loadPlan();
  if (!plan.enabled || !isMailConfigured()) return 0;
  const due = await Subscription.find({
    trialEndsAt: { $lte: now, $gt: new Date(now.getTime() - ENDED_WINDOW_MS) },
    trialEndedSentAt: null,
    paidUntil: null,
    razorpayStatus: { $nin: ['authenticated', 'active', 'pending'] },
  })
    .limit(limit)
    .lean();
  return sendEndedNotices(plan, now, due, {
    claim: () => [{ trialEndedSentAt: null }, { trialEndedSentAt: now }],
    release: () => ({ trialEndedSentAt: null }),
    subject: `Your ${plan.name} trial has ended`,
    lines: (sub) => [
      `Your free trial of ${plan.name} ended on ${day(sub.trialEndsAt)}.`,
      '',
      `Your journal, trades and notes are all still here, and the free features keep working. ${plan.name} features are paused until you subscribe.`,
      '',
      `${plan.name} is ${rupees(plan.priceMonthly)} a month; cancel any time.`,
      origin() ? `Subscribe: ${origin()}/billing` : null,
    ],
  });
}

/**
 * Daily job: tells members whose cancelled subscription ran out in the last 3 days that Premium has
 * ended, once per paid period (premiumEndedNoticeFor holds the paidUntil it was sent for).
 */
export async function sendPremiumEndedEmails(now = new Date(), limit = 500) {
  const plan = await loadPlan();
  if (!plan.enabled || !isMailConfigured()) return 0;
  const due = await Subscription.find({
    paidUntil: { $lte: now, $gt: new Date(now.getTime() - ENDED_WINDOW_MS) },
    cancelAtPeriodEnd: true,
    $expr: { $ne: ['$premiumEndedNoticeFor', '$paidUntil'] },
  })
    .limit(limit)
    .lean();
  return sendEndedNotices(plan, now, due, {
    claim: (sub) => [
      { paidUntil: sub.paidUntil, premiumEndedNoticeFor: { $ne: sub.paidUntil } },
      { premiumEndedNoticeFor: sub.paidUntil },
    ],
    release: (sub) => ({ premiumEndedNoticeFor: sub.premiumEndedNoticeFor ?? null }),
    subject: `Your ${plan.name} has ended`,
    lines: (sub) => [
      `Your ${plan.name} membership ended on ${day(sub.paidUntil)}, and it will not renew.`,
      '',
      `Your journal, trades and notes are all still here, and the free features keep working. ${plan.name} features are paused.`,
      '',
      'You are welcome back any time.',
      origin() ? `Subscribe again: ${origin()}/billing` : null,
    ],
  });
}

/**
 * Emails each due member once: skips anyone who still has Premium (a grant, a new subscription) or
 * no longer has access, claims the row first (so two runs never email twice) and gives the claim
 * back when the email could not be sent, so the next run tries again.
 */
async function sendEndedNotices(plan, now, due, { claim, release, subject, lines }) {
  let sent = 0;
  for (const sub of due) {
    const user = await User.findById(sub._id, { email: 1, status: 1, role: 1 }).lean();
    if (!user || user.status !== 'active') continue;
    if (computeMembership(plan, user, sub, now.getTime()).premium) continue;
    const [filter, set] = claim(sub);
    const claimed = await Subscription.updateOne({ _id: sub._id, ...filter }, { $set: set });
    if (!claimed.modifiedCount) continue;
    if (await sendQuietly(user.email, subject, lines(sub))) sent += 1;
    else await Subscription.updateOne({ _id: sub._id }, { $set: release(sub) });
  }
  return sent;
}

/**
 * Security notice after the password was changed, reset or added (not on first activation), so a
 * member whose account was taken over finds out. Never throws.
 */
export function passwordChangedEmail(user, { added = false } = {}) {
  const support = process.env.SUPPORT_EMAIL?.trim();
  return sendQuietly(
    user.email,
    added ? 'A password was added to your account' : 'Your password was changed',
    [
      added
        ? 'A password was just added to your Pirento Blank account, so you can now also sign in with it.'
        : 'The password for your Pirento Blank account was just changed. Your other devices were signed out.',
      '',
      `When: ${day(new Date())}`,
      `Account: ${user.email}`,
      '',
      `If this was not you, reset your password now${support ? ` and write to ${support}` : ''}.`,
      origin() ? `Reset password: ${origin()}/login?mode=reset` : null,
    ],
  );
}

/** Confirms a member's own account deletion (sent after the data is gone). Never throws. */
export function accountDeletedEmail(email) {
  return sendQuietly(email, 'Your Pirento Blank account was deleted', [
    'As you asked, your Pirento Blank account and everything in it were deleted: journal, plans, files, broker links and AI history.',
    'Payment records are kept only as long as the law requires.',
    '',
    'If you change your mind, you are welcome to ask for access again.',
    origin() ? `Pirento Blank: ${origin()}/` : null,
  ]);
}

/** A sign-in from a browser or device not among the member's recent ones. Never throws. */
export function newSignInEmail(user, device, at = new Date()) {
  const admin = user.role === 'admin';
  return sendQuietly(user.email, 'New sign-in to your Pirento Blank account', [
    'Your Pirento Blank account was just signed in to from a browser or device we have not seen before.',
    '',
    `When: ${dayAndTime(at)}`,
    `Device: ${device}`,
    `Account: ${user.email}`,
    '',
    'If this was you, there is nothing to do.',
    '',
    'If this was not you:',
    // Administrators have no password: their account is their Google account.
    admin
      ? '- Secure your Google account now, then tell the other administrators.'
      : '- Reset your password now with the button below.',
    '- In Settings → Signed-in devices, sign out any device you do not recognise.',
    supportEmail() ? `- Write to ${supportEmail()} so we can help.` : null,
    !admin && origin() ? `\nReset password: ${origin()}/login?mode=reset` : null,
  ]);
}

/** Tells a member an administrator paused (revoked) their access. Never throws. */
export function accessPausedEmail(email) {
  return sendQuietly(email, 'Your Pirento Blank access has been paused', [
    'Your access to Pirento Blank has been paused, so you cannot sign in for now. Your devices were signed out.',
    '',
    'If you had a Premium subscription, its renewal was stopped, so you will not be charged again.',
    '',
    supportEmail()
      ? `If you think this is a mistake or would like to know more, write to ${supportEmail()}.`
      : 'If you think this is a mistake or would like to know more, write to us from the contact page.',
    !supportEmail() && origin() ? `Contact us: ${origin()}/contact` : null,
  ]);
}

/** Tells a member their paused access was restored. Never throws. */
export function accessRestoredEmail(email) {
  return sendQuietly(email, 'Your Pirento Blank access is back', [
    'Good news: your Pirento Blank access has been restored, and your journal is as you left it.',
    '',
    'You were signed out when access was paused, so sign in again. Broker connections and Telegram or push alerts were removed then; reconnect them in Settings if you use them.',
    '',
    origin() ? `Sign in: ${origin()}/login` : null,
  ]);
}
