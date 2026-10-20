/**
 * The admin overview's report: new members and revenue per day for the last 30 days (IST), and a
 * feed of what happened recently (sign-ups, access requests, payments, problem reports and
 * administrator actions).
 */
import { AccessRequest, AdminAuditLog, Payment, ProblemReport, User } from '../../models/index.js';

const DAY_MS = 24 * 60 * 60_000;
const istDate = (field) => ({
  $dateToString: { format: '%Y-%m-%d', date: field, timezone: 'Asia/Kolkata' },
});
const istDay = (time) => new Date(time + 5.5 * 60 * 60_000).toISOString().slice(0, 10);

/** [{ date, signups, revenue }] for each of the last `days` IST days, oldest first. */
export async function dailySeries(now = Date.now(), days = 30) {
  const since = new Date(now - days * DAY_MS);
  const [signups, revenue] = await Promise.all([
    User.aggregate([
      { $match: { createdAt: { $gt: since } } },
      { $group: { _id: istDate('$createdAt'), count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { status: 'captured', paidAt: { $gt: since } } },
      { $group: { _id: istDate('$paidAt'), total: { $sum: '$amount' } } },
    ]),
  ]);
  const signupsBy = new Map(signups.map((row) => [row._id, row.count]));
  const revenueBy = new Map(revenue.map((row) => [row._id, row.total]));
  return Array.from({ length: days }, (_, index) => {
    const date = istDay(now - (days - 1 - index) * DAY_MS);
    return { date, signups: signupsBy.get(date) ?? 0, revenue: revenueBy.get(date) ?? 0 };
  });
}

/** The latest `limit` events across the platform, newest first. */
export async function recentActivity(limit = 20) {
  const latest = (model, filter, sort, projection) =>
    model.find(filter, projection).sort(sort).limit(limit).lean();
  const [users, requests, payments, reports, actions] = await Promise.all([
    latest(User, {}, { createdAt: -1 }, { email: 1, role: 1, createdAt: 1 }),
    latest(AccessRequest, {}, { createdAt: -1 }, { name: 1, email: 1, createdAt: 1 }),
    latest(Payment, {}, { paidAt: -1 }, { userId: 1, amount: 1, status: 1, paidAt: 1 }),
    latest(ProblemReport, {}, { createdAt: -1 }, { email: 1, category: 1, createdAt: 1 }),
    latest(
      AdminAuditLog,
      {},
      { createdAt: -1 },
      { actorEmail: 1, action: 1, target: 1, createdAt: 1 },
    ),
  ]);
  const payers = new Map(
    (
      await User.find(
        { _id: { $in: payments.map((row) => row.userId).filter(Boolean) } },
        { email: 1 },
      ).lean()
    ).map((user) => [user._id, user.email]),
  );
  const events = [
    ...users.map((row) => ({
      kind: 'member',
      at: row.createdAt,
      text: `${row.email} ${row.role === 'admin' ? 'was added as an administrator' : 'joined'}`,
    })),
    ...requests.map((row) => ({
      kind: 'request',
      at: row.createdAt,
      text: `${row.name} (${row.email}) asked to join`,
    })),
    ...payments.map((row) => ({
      kind: row.status === 'failed' ? 'failed-payment' : 'payment',
      at: row.paidAt,
      text: `${payers.get(row.userId) ?? 'A member'}: payment of ₹${row.amount.toLocaleString('en-IN')} ${row.status === 'failed' ? 'failed' : row.status}`,
    })),
    ...reports.map((row) => ({
      kind: 'report',
      at: row.createdAt,
      text: `${row.email} reported a problem (${row.category})`,
    })),
    ...actions.map((row) => ({
      kind: 'admin',
      at: row.createdAt,
      text: `${row.actorEmail || 'An administrator'}: ${row.action}${row.target ? ` · ${row.target}` : ''}`,
    })),
  ];
  return events
    .filter((event) => event.at)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((event) => ({ ...event, at: event.at.toISOString() }));
}
