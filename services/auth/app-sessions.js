/**
 * Checks that a stored login session is still valid for broker requests.
 */
import { nativeDb } from '../../config/database.js';
import { User } from '../../models/index.js';
import { accessProblem } from './accounts.js';

/**
 * True while the named login session is still stored, unexpired, and its account
 * still has active workspace access.
 */
export async function validateAppSession(userId, sessionId) {
  const session = await nativeDb()
    .collection('sessions')
    .findOne(
      {
        'session.auth.userId': userId,
        'session.auth.sessionId': sessionId,
        expires: { $gt: new Date() },
      },
      { projection: { _id: 1, 'session.auth': 1 } },
    );
  if (!session) return false;
  const user = await User.findById(userId);
  return !(await accessProblem(user));
}
