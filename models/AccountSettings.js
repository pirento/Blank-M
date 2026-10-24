/** Per-user account settings. Balance is always derived from trades, never stored. */
import mongoose from 'mongoose';

const accountSettingsSchema = new mongoose.Schema(
  {
    _id: String, // user id
    openingBalance: { type: Number, default: 100000, min: 0 },
    charges: { type: mongoose.Schema.Types.Mixed, default: null },
    /** F&O charge rates: { futures, options }, same fields as `charges`. */
    foCharges: { type: mongoose.Schema.Types.Mixed, default: null },
    /**
     * Weekly summary email and the last week it was sent for. Turned on for new members when their
     * account is activated (welcomeMember); off by default so existing members are not signed up.
     */
    weeklyReportEmail: { type: Boolean, default: false },
    /** Emails the administrator sends to all members (on unless the member turns them off). */
    announcementEmails: { type: Boolean, default: true },
    weeklyReportSentFor: { type: String, default: null },
    /** Add an AI coach review of the week to the weekly email. */
    weeklyAiCoach: { type: Boolean, default: false },
    /** Opt-in: after the close, add today's broker fills and send the day's summary to Telegram. */
    dailyAutoImport: { type: Boolean, default: false },
    /** The last trading date (IST) the daily import ran for. */
    dailyAutoImportFor: { type: String, default: null },
    /** Opt-in: before the open, send a short pre-market plan to Telegram. */
    premarketPlan: { type: Boolean, default: false },
    /** The last trading date (IST) the pre-market plan was sent for. */
    premarketPlanFor: { type: String, default: null },
    /** { dailyLossLimit, maxTradesPerDay, monthlyProfitGoal } (shared/risk-limits.js). */
    riskLimits: { type: mongoose.Schema.Types.Mixed, default: null },
    /** The member's own opt-in to place live orders (also requires the server switch). */
    liveTradingEnabled: { type: Boolean, default: false },
    /** Details for the member's GST invoices: { name, state, gstin, address } (Billing page). */
    billingDetails: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' }, minimize: false },
);

// The scheduled jobs look for opted-in members only; partial indexes keep each lookup to that small
// set instead of reading every member's settings.
accountSettingsSchema.index(
  { weeklyReportSentFor: 1 },
  { partialFilterExpression: { weeklyReportEmail: true } },
);
accountSettingsSchema.index(
  { dailyAutoImportFor: 1 },
  { partialFilterExpression: { dailyAutoImport: true } },
);
accountSettingsSchema.index(
  { premarketPlanFor: 1 },
  { partialFilterExpression: { premarketPlan: true } },
);

export const AccountSettings =
  mongoose.models.AccountSettings || mongoose.model('AccountSettings', accountSettingsSchema);
