/**
 * The member's AI chat history: save messages, keep the newest CHAT_KEEP, and clear it.
 */
import { z } from 'zod';
import { ChatMessage } from '../../models/index.js';
import { HttpError } from '../errors.js';
import { toChatMessage } from './mappers.js';

/** Only the recent window of the chat history is loaded. */
export const CHAT_HISTORY_LIMIT = 200;
/** Messages kept per member; older ones are deleted as new ones arrive (the UI shows 200). */
export const CHAT_KEEP = 1000;
const CHAT_TEXT_MAX = 20_000;

/* ----------------------------------- chat ----------------------------------- */

/** Saves one AI chat message (user or assistant) to the member's conversation history. */
export async function addChatMessage(userId, message) {
  const parsed = z
    .object({
      role: z.enum(['user', 'assistant']),
      text: z.string().max(100000),
      timestamp: z.string().datetime({ offset: true }).optional(),
    })
    .safeParse(message);
  if (!parsed.success) throw new HttpError('Invalid chat message.', 400);
  const saved = await ChatMessage.create({
    userId,
    role: parsed.data.role,
    // Long enough for any real answer; keeps one message from holding 100 KB.
    text: parsed.data.text.slice(0, CHAT_TEXT_MAX),
    createdAt: parsed.data.timestamp ? new Date(parsed.data.timestamp) : new Date(),
  });
  await trimChat(userId);
  return toChatMessage(saved.toObject());
}

/** Deletes a member's chat messages beyond the newest CHAT_KEEP (also after a restore). */
export async function trimChat(userId) {
  const cutoff = await ChatMessage.findOne({ userId }, { createdAt: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .skip(CHAT_KEEP)
    .lean();
  if (!cutoff) return;
  const old = await ChatMessage.find({ userId, createdAt: { $lte: cutoff.createdAt } }, { _id: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  await ChatMessage.deleteMany({ userId, _id: { $in: old.map((row) => row._id) } });
}

/** Delete the full owner's conversation, including rows outside the recent UI window. */
export async function deleteChatHistory(userId) {
  if (!String(userId || '').trim()) {
    throw new HttpError('You must be signed in to clear your conversation.', 401);
  }
  await ChatMessage.deleteMany({ userId });
}
