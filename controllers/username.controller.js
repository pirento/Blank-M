/**
 * The member's optional sign-in username: read it or claim it once.
 */
import { LoginUsername, USERNAME_PATTERN } from '../models/index.js';
import { HttpError } from '../services/errors.js';

/** The member's optional, immutable sign-in alias. */
export async function getUsername(req, res) {
  const row = await LoginUsername.findOne({ userId: req.member.userId }).lean();
  res.json({ username: row?._id ?? null });
}

/**
 * POST /api/username { username }: claims the sign-in username (201). Repeating the same claim
 * returns 200; a different one once set, or one already taken, is 409.
 */
export async function claimUsername(req, res) {
  const username = String(req.body?.username ?? '')
    .trim()
    .toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError('Use 3–32 letters, numbers or underscores, starting with a letter.', 400);
  }
  const existing = await LoginUsername.findOne({ userId: req.member.userId }).lean();
  if (existing) {
    if (existing._id !== username) {
      throw new HttpError('Username is already set and cannot be changed', 409);
    }
    res.json({ username: existing._id });
    return;
  }
  try {
    await LoginUsername.create({ _id: username, userId: req.member.userId });
  } catch (error) {
    if (error?.code === 11000) {
      throw new HttpError('That username is unavailable. Choose another username.', 409);
    }
    throw error;
  }
  res.status(201).json({ username });
}
