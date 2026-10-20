/**
 * Sends one message to a member over the channels they chose: push (every
 * subscribed device), email and their linked Telegram chat. Delivery failures are logged, never thrown,
 * so one broken channel cannot block the others.
 */
import { User } from '../../models/index.js';
import { isMailConfigured, sendMail } from '../mailer.js';
import { createLogger } from '../logger.js';
import { sendPush } from './push.js';
import { sendToMember } from '../telegram/bot.js';

const log = createLogger('notify');

/**
 * @param {string} userId
 * @param {{ title: string, body: string, url?: string, tag?: string }} message
 * @param {{ push?: boolean, email?: boolean, telegram?: boolean }} channels Telegram is on
 *   unless set to false (it only sends when the member linked a chat).
 * @returns {Promise<{ push: number, email: boolean, telegram: boolean }>}
 */
export async function notifyMember(userId, message, channels = { push: true }) {
  const result = { push: 0, email: false, telegram: false };
  if (channels.telegram !== false) {
    result.telegram = await sendToMember(userId, `${message.title}\n${message.body}`);
  }
  if (channels.push) {
    try {
      result.push = await sendPush(userId, message);
    } catch {
      log.warn('push channel failed');
    }
  }
  if (channels.email && isMailConfigured()) {
    try {
      const user = await User.findById(userId, { email: 1 }).lean();
      if (user?.email) {
        const origin = String(process.env.APP_URL || '').replace(/\/$/, '');
        await sendMail({
          to: user.email,
          subject: message.title,
          text: `${message.body}${origin && message.url ? `\n\nOpen Pirento Blank: ${origin}${message.url}` : ''}`,
        });
        result.email = true;
      }
    } catch {
      log.warn('email channel failed');
    }
  }
  return result;
}
