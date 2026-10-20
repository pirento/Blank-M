/**
 * A problem a member reported from Settings → Report a problem. Administrators see it on the admin
 * overview and mark it fixed (the member is emailed). Fixed reports are deleted after 180 days.
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

export const PROBLEM_CATEGORIES = ['bug', 'billing', 'account', 'data', 'other'];

const problemReportSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true },
    email: { type: String, required: true },
    category: { type: String, enum: PROBLEM_CATEGORIES, required: true },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    /** The page the member was on, e.g. "/journal". */
    page: { type: String, default: '', maxlength: 200 },
    status: { type: String, enum: ['open', 'fixed'], default: 'open' },
    /** What the administrator did, sent to the member when it is marked fixed. */
    adminNote: { type: String, default: '', maxlength: 1000 },
    resolvedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
problemReportSchema.index({ status: 1, createdAt: -1 });
problemReportSchema.index({ userId: 1 });
problemReportSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const ProblemReport =
  mongoose.models.ProblemReport || mongoose.model('ProblemReport', problemReportSchema);
