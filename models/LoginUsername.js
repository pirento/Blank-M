/**
 * An optional immutable sign-in alias. The reservation is kept even if the
 * account is deleted, so a future identity cannot inherit it.
 */
import mongoose from 'mongoose';

export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

const loginUsernameSchema = new mongoose.Schema({
  _id: { type: String, match: USERNAME_PATTERN }, // username
  userId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
loginUsernameSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'string' } } },
);

export const LoginUsername =
  mongoose.models.LoginUsername || mongoose.model('LoginUsername', loginUsernameSchema);
