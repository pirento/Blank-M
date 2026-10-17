/** Errors carrying an HTTP status; messages are safe to show the user. */
export class HttpError extends Error {
  constructor(message, status = 500, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, extra);
  }
}

export class ServerConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerConfigurationError';
  }
}

/** Express's `next` only catches synchronous throws; wrap async handlers. */
export function asyncHandler(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}
