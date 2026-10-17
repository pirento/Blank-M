/**
 * Same-origin JSON client. Every state-changing request carries the CSRF token
 * and the login-session identity the page was rendered with, so an action
 * queued by a previous account can never run against a newer sign-in.
 */

export class ApiError extends Error {
  constructor(message, status, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function meta(name) {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
}

/** The CSRF token from the page's `csrf-token` meta tag, or ''. */
export function csrfToken() {
  return meta('csrf-token');
}

/** The login-session identity from the `blank-session` meta tag, or ''. */
export function sessionIdentity() {
  return meta('blank-session');
}

/** Headers for an API request: Accept, JSON Content-Type when `json`, CSRF token and session identity. */
export function requestHeaders(json = true) {
  const headers = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  const csrf = csrfToken();
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const identity = sessionIdentity();
  if (identity) headers['X-Blank-Session'] = identity;
  return headers;
}

/**
 * fetch() wrapper for the JSON API. Sends `body` as JSON or `form` as-is, honours an abort
 * `signal`, times out after `timeout` ms, and resolves to the parsed JSON (or null). Throws
 * ApiError: the server's `error` message on a non-2xx, 499 cancelled, 504 timeout, 0 network.
 */
export async function api(path, { method = 'GET', body, form, signal, timeout = 30_000 } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeout,
  );
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: requestHeaders(!form && body !== undefined),
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ApiError('Request cancelled.', 499);
    if (controller.signal.aborted) throw new ApiError('The request took too long. Try again.', 504);
    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      0,
      error,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

/** A user-facing message for a caught error: its message when it is an Error with one, else fallback. */
export function errorMessage(error, fallback = 'Something went wrong. Please try again.') {
  return error instanceof Error && error.message ? error.message : fallback;
}
