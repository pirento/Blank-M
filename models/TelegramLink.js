/**
 * Telegram: the chat linked to a member, and short-lived one-time codes used
 * to link it (only a digest of each code is stored).
 */
import mongoose from 'mongoose';
import { timestamps, uuidId } from './helpers.js';

const telegramLinkSchema = new mongoose.Schema(
  {
    _id: uuidId,
    userId: { type: String, required: true, unique: true },
    chatId: { type: String, required: true, unique: true },
    username: { type: String, default: '' },
  },
  timestamps,
);

const telegramLinkCodeSchema = new mongoose.Schema({
  _id: String, // SHA-256 of the code
  userId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
telegramLinkCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TelegramLink =
  mongoose.models.TelegramLink || mongoose.model('TelegramLink', telegramLinkSchema);
export const TelegramLinkCode =
  mongoose.models.TelegramLinkCode || mongoose.model('TelegramLinkCode', telegramLinkCodeSchema);
