/**
 * Authenticated GET helper for the Kite REST API: auth headers, timeout,
 * size-capped body reads and mapping of HTTP/transport failures to MarketDataError.
 */
import { MarketDataError } from '../types.js';
import { API_BASE, TIMEOUT_MS } from './config.js';
import { invalidateConnection } from './connection.js';

/**
 * 401, or 403 with TokenException, means the access token is no longer valid.
 * Any other 403 (PermissionException) is a missing permission, e.g. a Kite
 * "Personal" app has no quotes or historical data: the session stays connected.
 */
export async function throwAuthFailure(response, userId, connection) {
  const payload = await response.json().catch(() => null);
  if (response.status === 401 || payload?.error_type === 'TokenException') {
    await invalidateConnection(userId, connection.ciphertext);
    throw new MarketDataError('The Zerodha session expired. Reconnect in Settings.', 401);
  }
  const message = typeof payload?.message === 'string' ? payload.message.slice(0, 300) : null;
  const error = new MarketDataError(
    message ? `Zerodha denied the request: ${message}` : 'Zerodha denied the request.',
    403,
  );
  error.permissionDenied = true;
  throw error;
}

/**
 * GETs a Kite API path with the member's access token (12 s timeout, no redirects) and returns the
 * parsed JSON. With `maxResponseBytes`, the body is streamed and rejected once it exceeds the cap.
 * Auth failures may expire the stored session (see throwAuthFailure); other failures become
 * MarketDataError 429, 502 or 504.
 */
export async function kiteFetch(path, connection, userId, maxResponseBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `token ${process.env.KITE_API_KEY}:${connection.accessToken}`,
        'X-Kite-Version': '3',
      },
    });
    if (response.status === 401 || response.status === 403) {
      await throwAuthFailure(response, userId, connection);
    }
    if (!response.ok) {
      throw new MarketDataError(
        `Zerodha returned ${response.status}`,
        response.status === 429 ? 429 : 502,
      );
    }
    if (maxResponseBytes !== undefined) {
      if (!response.body || Number(response.headers.get('content-length')) > maxResponseBytes) {
        await response.body?.cancel();
        throw new MarketDataError('Zerodha returned an invalid or oversized response.', 502);
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxResponseBytes) {
            await reader.cancel();
            throw new MarketDataError('Zerodha returned an oversized response.', 502);
          }
          chunks.push(chunk.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally {
        reader.releaseLock();
      }
    }
    return await response.json();
  } catch (error) {
    if (error instanceof MarketDataError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new MarketDataError('Zerodha timed out', 504);
    }
    throw new MarketDataError('Could not reach Zerodha', 502);
  } finally {
    clearTimeout(timer);
  }
}
