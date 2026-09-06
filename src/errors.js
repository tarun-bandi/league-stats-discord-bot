export class UserFacingError extends Error {}
export class RiotRateLimitError extends UserFacingError {
  constructor(retryAt) {
    super("Riot is rate-limiting requests. Try again shortly.");
    this.retryAt = retryAt;
    this.httpStatus = 429;
  }
}
