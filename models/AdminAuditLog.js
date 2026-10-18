/**
 * Who changed what in the admin panel: settings, plans, member access and
 * subscription grants. Secret values are never written here, only the fact
 * that they changed. Kept for two years, then removed automatically.
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;

const adminAuditLogSchema = new mongoose.Schema(
  {
    _id: uuidId,
    actorId: { type: String, required: true },
    actorEmail: { type: String, default: '' },
    /** Short machine name, e.g. "setting.update", "billing.plan", "member.grant". */
    action: { type: String, required: true, maxlength: 80 },
    /** What it was done to: a setting key, a member email, etc. */
    target: { type: String, default: '', maxlength: 320 },
    /** Non-secret details for the log view (old/new plain values, days granted…). */
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
// Expires old entries; the same index serves the newest-first list in the panel.
adminAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: TWO_YEARS_SECONDS });

export const AdminAuditLog =
  mongoose.models.AdminAuditLog || mongoose.model('AdminAuditLog', adminAuditLogSchema);
