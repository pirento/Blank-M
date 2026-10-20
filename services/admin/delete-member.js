/**
 * Deleting a member for good (the privacy policy promises it on request) and
 * removing what keeps working for a member whose access was revoked.
 *
 * Kept on purpose after deletion: payments (financial records the law requires),
 * the trial claim (one trial per person) and the admin audit log.
 */
import {
  AccountSettings,
  AiUsageEvent,
  AllowedUser,
  AuthToken,
  BrokerConnection,
  BrokerOAuthState,
  ChatMessage,
  CoachReview,
  JournalEmbedding,
  LiveOrder,
  LoginUsername,
  OrderPlanRecord,
  PaperTrade,
  PriceAlert,
  PushSubscription,
  ResearchRun,
  ShareLink,
  Strategy,
  StrategyEvidence,
  StrategyEvidenceReview,
  Subscription,
  TelegramLink,
  TelegramLinkCode,
  Trade,
  TradingRule,
  User,
  WatchlistItem,
} from '../../models/index.js';
import { revokeUserSessions } from '../auth/accounts.js';
import { endSubscriptionNow } from '../billing/subscriptions.js';
import { HttpError } from '../errors.js';
import { removeOwnerFolder } from '../storage.js';

/** Collections whose rows belong to one member through `userId`. */
const MEMBER_COLLECTIONS = [
  Trade,
  Strategy,
  TradingRule,
  WatchlistItem,
  ChatMessage,
  CoachReview,
  JournalEmbedding,
  AiUsageEvent,
  ResearchRun,
  OrderPlanRecord,
  StrategyEvidence,
  StrategyEvidenceReview,
  PaperTrade,
  PriceAlert,
  LiveOrder,
  ShareLink,
  BrokerConnection,
  BrokerOAuthState,
  PushSubscription,
  TelegramLink,
  TelegramLinkCode,
  AuthToken,
  LoginUsername,
];

/**
 * A revoked member must not keep using the platform through background work: drop their broker
 * tokens, push devices and Telegram link, so alerts, quotes and messages stop.
 */
export async function detachRevokedMember(userId) {
  await Promise.all([
    BrokerConnection.deleteMany({ userId }),
    PushSubscription.deleteMany({ userId }),
    TelegramLink.deleteMany({ userId }),
  ]);
}

/**
 * Deletes a member and all their data (journal, files, AI data, broker links, sessions), after
 * cancelling any Razorpay subscription. Administrators are refused: demote them first.
 * Returns `{ email, rows, files }`.
 */
export async function deleteMember(email) {
  const user = await User.findOne({ email: String(email).trim().toLowerCase() }).lean();
  if (!user) throw new HttpError('No member has this email.', 404);
  if (user.role === 'admin') throw new HttpError('Administrators cannot be deleted here.', 409);
  const userId = user._id;
  await endSubscriptionNow(userId);
  await revokeUserSessions(userId);
  let rows = 0;
  for (const model of MEMBER_COLLECTIONS) rows += (await model.deleteMany({ userId })).deletedCount;
  rows += (await AccountSettings.deleteOne({ _id: userId })).deletedCount;
  rows += (await Subscription.deleteOne({ _id: userId })).deletedCount;
  let files = 0;
  for (const bucketName of ['statements', 'voice-notes', 'trade-screenshots']) {
    files += await removeOwnerFolder(bucketName, userId);
  }
  await AllowedUser.deleteOne({ _id: user.email });
  await User.deleteOne({ _id: userId });
  return { email: user.email, rows, files };
}
