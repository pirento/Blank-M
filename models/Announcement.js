/**
 * An email the administrator sent to members (admin panel → Announcements),
 * with its progress. Kept as the record of what was sent to whom (by audience).
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

const announcementSchema = new mongoose.Schema(
  {
    _id: uuidId,
    subject: { type: String, required: true },
    body: { type: String, required: true },
    /** all | premium | free */
    audience: { type: String, enum: ['all', 'premium', 'free'], required: true },
    status: { type: String, enum: ['sending', 'done'], default: 'sending' },
    sent: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    createdBy: { type: String, required: true },
    finishedAt: { type: Date, default: null },
    /** The last member (user id) handled, so a send stopped by a restart resumes after it. */
    lastUserId: { type: String, default: '' },
    /** The process sending it renews this; once it lapses another process takes over. */
    leaseUntil: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
announcementSchema.index({ createdAt: -1 });
// Only one announcement can be sending at a time (two clicks or two admins cannot start two).
announcementSchema.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: 'sending' } },
);

export const Announcement =
  mongoose.models.Announcement || mongoose.model('Announcement', announcementSchema);
