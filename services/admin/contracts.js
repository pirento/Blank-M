/**
 * Error for administrator and invitation operations: carries the HTTP status
 * (503 by default, when the outcome of an access change cannot be confirmed).
 */
export class AdminContractError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
    this.name = 'AdminContractError';
  }
}
