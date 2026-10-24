/** Rejects anything but the expected method, so handlers can assume it. */
export function requireMethod(req, res, method) {
  if ((req.method ?? 'GET').toUpperCase() !== method) {
    res.status(405).json({ error: `Method not allowed. Use ${method}.` });
    return false;
  }
  return true;
}

/** Express parses JSON bodies; this copes with the case where it did not. */
export function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    const { _csrf, ...body } = req.body;
    void _csrf;
    return body;
  }
  if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * The client address for rate limits. `req.ip` honours `trust proxy` (the
 * hop count from TRUST_PROXY), so behind Nginx it is the real client rather
 * than the proxy; without a proxy it is the socket address. Keep the app
 * reachable only through the proxy (HOST=127.0.0.1) so the header that
 * proxy sets cannot be forged.
 */
export function clientAddress(req) {
  return req.ip || req.socket?.remoteAddress || 'unidentified-client';
}
