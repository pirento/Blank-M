/**
 * Authorises scheduled maintenance requests with the CRON_SECRET bearer token.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

function matchesSecret(received, expected) {
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(received), hash(expected));
}

/**
 * Scheduled jobs authenticate with `Authorization: Bearer <CRON_SECRET>`.
 * Writes the error response and returns false when the request is not allowed.
 */
export function authorizeMaintenance(req, res) {
  const authorization = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '');
  if (!authorization) {
    res.status(401).json({ error: 'Maintenance authorization is required.' });
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() !== secret || secret.length < 32) {
    res.status(503).json({ error: 'Maintenance is not configured.' });
    return false;
  }
  if (!matchesSecret(authorization[1], secret)) {
    res.status(401).json({ error: 'Maintenance authorization is required.' });
    return false;
  }
  return true;
}
