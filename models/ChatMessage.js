/**
 * A message in the member's AI chat history.
 */
import mongoose from 'mongoose';
import { uuidId } from './helpers.js';

const chatMessageSchema = new mongoose.Schema({
  _id: uuidId,
  userId: { type: String, required: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, default: '' },
  attachmentPath: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
chatMessageSchema.index({ userId: 1, createdAt: -1, _id: -1 });

export const ChatMessage =
  mongoose.models.ChatMessage || mongoose.model('ChatMessage', chatMessageSchema);
