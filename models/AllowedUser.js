/** The invite-only allowlist. No account can be created without an active row. */
import mongoose from 'mongoose';

const allowedUserSchema = new mongoose.Schema(
  {
    _id: { type: String, lowercase: true, trim: true }, // email
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    invitedBy: { type: String, default: null },
    authUserId: { type: String, default: null },
    invitedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
);
allowedUserSchema.index(
  { authUserId: 1 },
  { unique: true, partialFilterExpression: { authUserId: { $type: 'string' } } },
);
allowedUserSchema.virtual('email').get(function email() {
  return this._id;
});

export const AllowedUser =
  mongoose.models.AllowedUser || mongoose.model('AllowedUser', allowedUserSchema);
