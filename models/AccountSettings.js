/** Per-user account settings. Balance is always derived from trades, never stored. */
import mongoose from 'mongoose';

const accountSettingsSchema = new mongoose.Schema(
  {
    _id: String, // user id
    openingBalance: { type: Number, default: 100000, min: 0 },
    charges: { type: mongoose.Schema.Types.Mixed, default: null },
    /** F&O charge rates: { futures, options }, same fields as `charges`. */
    foCharges: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Opt-in weekly summary email, and the last week (Monday date) it was sent for. */
    weeklyReportEmail: { type: Boolean, default: false },
    weeklyReportSentFor: { type: String, default: null },
    /** Add an AI coach review of the week to the weekly email. */
    weeklyAiCoach: { type: Boolean, default: false },
    /** Opt-in: after the close, add today's broker fills and send the day's summary to Telegram. */
    dailyAutoImport: { type: Boolean, default: false },
    /** The last trading date (IST) the daily import ran for. */
    dailyAutoImportFor: { type: String, default: null },
    /** { dailyLossLimit, maxTradesPerDay, monthlyProfitGoal } (shared/risk-limits.js). */
    riskLimits: { type: mongoose.Schema.Types.Mixed, default: null },
    /** The member's own opt-in to place live orders (also requires the server switch). */
    liveTradingEnabled: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' }, minimize: false },
);

export const AccountSettings =
  mongoose.models.AccountSettings || mongoose.model('AccountSettings', accountSettingsSchema);
