/**
 * A visitor's request to join, sent from the form on the home page. An administrator approves it
 * (the member is invited by email) or rejects it. Decided requests are deleted after 90 days.
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

const accessRequestSchema = new mongoose.Schema(
  {
    _id: uuidId,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 320 },
    phone: { type: String, default: '', trim: true, maxlength: 20 },
    message: { type: String, default: '', trim: true, maxlength: 1000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    /** Set when decided; MongoDB removes the request then (data kept no longer than needed). */
    purgeAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
accessRequestSchema.index({ status: 1, createdAt: -1 });
// One open request per address: a second submission only refreshes the first.
accessRequestSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
accessRequestSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const AccessRequest =
  mongoose.models.AccessRequest || mongoose.model('AccessRequest', accessRequestSchema);
