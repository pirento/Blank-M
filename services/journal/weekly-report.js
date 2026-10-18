/**
 * Weekly report emails: last week's trading summary for members who opted in.
 */
import { AccountSettings, OrderPlanRecord, Trade, User } from '../../models/index.js';
import { formatCurrency } from '../../middleware/view-helpers.js';
import { pnlBySymbol, summarisePerformance } from '../../shared/pnl.js';
import {
  inReportPeriod,
  instantBusinessDate,
  reportPeriod,
  reportPeriodTitle,
} from '../../shared/business-dates.js';
import { todayInIst } from '../../shared/market.js';
import { accessProblem } from '../auth/accounts.js';
import { isMailConfigured, sendMail } from '../mailer.js';
import { toTrade } from './workspace.js';
import { hasOpenAiKey } from '../ai/openai-key.js';
import { findWeeklyReview, runCoachReview } from '../ai/coach-review.js';
import { createLogger } from '../logger.js';

const log = createLogger('weekly-report');

/** The week's AI coach review as email text, or '' when off, unavailable or failed. */
async function coachSection(userId, period, tradeCount) {
  if (!tradeCount || !hasOpenAiKey()) return '';
  const settings = await AccountSettings.findById(userId, { weeklyAiCoach: 1 }).lean();
  if (!settings?.weeklyAiCoach) return '';
  let review;
  try {
    review =
      (await findWeeklyReview(userId, period.start, period.end)) ??
      (await runCoachReview(userId, { period: 'week', date: period.end }));
  } catch {
    log.warn('weekly coach review failed');
    return '';
  }
  const { summary, disciplineScore, focus } = review.review;
  return [
    '',
    `AI coach (discipline ${disciplineScore}/10)`,
    summary,
    'Focus next week:',
    ...focus.map((item) => `- ${item}`),
  ].join('\n');
}

/** The most recent complete Monday–Sunday week in IST. */
export function lastCompletedWeek(today = todayInIst()) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return reportPeriod('weekly', date.toISOString().slice(0, 10));
}

/**
 * Plain-text weekly report for the period: trade totals, win rate, P&L, best and weakest symbol,
 * and plans saved. Returns `{ subject, text, summary }`.
 */
export async function buildWeeklyReport(userId, period) {
  const rows = await Trade.find({
    userId,
    tradeDate: { $gte: period.start, $lte: period.end },
  }).lean();
  const trades = rows.map(toTrade).filter((trade) => inReportPeriod(trade.date, period));
  // Only the creation time is needed; a member's plan history can be long.
  const plans = await OrderPlanRecord.find(
    { userId, recordKind: 'plan' },
    { 'record.createdAt': 1 },
  ).lean();
  const plansInWeek = plans.filter((row) =>
    inReportPeriod(instantBusinessDate(new Date(row.record?.createdAt ?? 0)), period),
  ).length;
  const summary = summarisePerformance(trades);
  const bySymbol = pnlBySymbol(trades);
  const best = bySymbol[0];
  const worst = bySymbol.at(-1);
  const lines = [
    reportPeriodTitle(period),
    `${period.start} to ${period.end} (IST, Monday–Sunday)`,
    '',
  ];
  if (!trades.length) {
    lines.push('No journal trades were recorded this week.');
  } else {
    lines.push(
      `Trades: ${summary.totalTrades} (${summary.wins} wins, ${summary.losses} losses)`,
      `Win rate: ${summary.winRate.toFixed(1)}%`,
      `Gross P&L: ${formatCurrency(summary.grossPnl)}`,
      `Charges: ${formatCurrency(summary.charges)}`,
      `Net P&L: ${formatCurrency(summary.netPnl)}`,
      `Profit factor: ${summary.profitFactor === null ? 'no losing trades' : summary.profitFactor}`,
    );
    if (best) lines.push(`Best symbol: ${best.key} (${formatCurrency(best.netPnl)})`);
    if (worst && worst !== best)
      lines.push(`Weakest symbol: ${worst.key} (${formatCurrency(worst.netPnl)})`);
  }
  lines.push(
    `Order plans saved: ${plansInWeek}`,
    '',
    'Journal records are your own entries and are not verified broker executions.',
  );
  return {
    subject: `Your Pirento Blank weekly report · ${period.start} to ${period.end}`,
    text: lines.join('\n'),
    summary,
  };
}

/**
 * Emails the weekly report to the member, appending their AI coach review when they opted in and
 * one is available (running a new review if none is saved). Returns the report.
 */
export async function sendWeeklyReport(user, period) {
  const report = await buildWeeklyReport(user._id, period);
  const coach = await coachSection(user._id, period, report.summary.totalTrades);
  const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : '';
  await sendMail({
    to: user.email,
    subject: report.subject,
    text: `${report.text}${coach}${origin ? `\n\nOpen your reports: ${origin}/reports` : ''}\n\nTurn these emails off in Settings → Email reports.`,
  });
  return report;
}

/**
 * Send last week's report to every member who opted in, at most once per week
 * per member. Returns counts; failures are counted and retried on the next run.
 */
export async function sendWeeklyReports({ today = todayInIst(), limit = 200 } = {}) {
  if (!isMailConfigured()) return { sent: 0, skipped: 0, failed: 0, configured: false };
  const period = lastCompletedWeek(today);
  const due = await AccountSettings.find({
    weeklyReportEmail: true,
    weeklyReportSentFor: { $ne: period.start },
  })
    .limit(limit)
    .lean();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const settings of due) {
    const user = await User.findById(settings._id);
    if (!user || (await accessProblem(user))) {
      skipped += 1;
      continue;
    }
    try {
      await sendWeeklyReport(user, period);
      await AccountSettings.updateOne(
        { _id: user._id },
        { $set: { weeklyReportSentFor: period.start } },
      );
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    sent,
    skipped,
    failed,
    configured: true,
    week: period.start,
    moreMayRemain: due.length === limit,
  };
}
