/**
 * Standardized application error class matching the SyncSpace error envelope.
 * Reference: docs/SPECIFICATION.md Section 10.5
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError("VALIDATION_ERROR", 400, message, details);
  }

  static unauthenticated(message = "Authentication required") {
    return new AppError("UNAUTHENTICATED", 401, message);
  }

  static forbidden(message = "Insufficient permissions") {
    return new AppError("FORBIDDEN", 403, message);
  }

  static notFound(message = "Resource not found") {
    return new AppError("NOT_FOUND", 404, message);
  }

  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(code, 409, message, details);
  }

  static invalidState(message: string) {
    return new AppError("INVALID_STATE_TRANSITION", 422, message);
  }

  static rateLimited(message = "Too many requests. Please try again later.") {
    return new AppError("RATE_LIMITED", 429, message);
  }
}

