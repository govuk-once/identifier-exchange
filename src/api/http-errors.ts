import type { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { errorResponse } from './errors.js';

/**
 * Throw one of these from a handler (or from inside runInTransaction) to end
 * the request with an error response. Inside a transaction it also rolls back
 * and is never retried. The response has the shared API error shape
 * (src/api/errors.ts).
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends HttpError {
  constructor(code = 'BAD_REQUEST', message = 'Invalid request', details?: string[]) {
    super(400, code, message, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(code = 'NOT_FOUND', message = 'Resource not found') {
    super(404, code, message);
  }
}

export class ConflictError extends HttpError {
  constructor(code = 'CONFLICT', message = 'Resource conflict') {
    super(409, code, message);
  }
}

/**
 * HttpError -> its own status and code, logged as a warning. Anything else is
 * a 500 with a generic message (nothing from the error reaches the client),
 * logged as an error.
 */
export const mapErrorToHttpResponse = (
  error: unknown,
  logger: Logger,
  requestId?: string,
): APIGatewayProxyResult => {
  if (error instanceof HttpError) {
    logger.warn(error.message, { code: error.code, statusCode: error.statusCode });
    return errorResponse(error.statusCode, {
      code: error.code,
      message: error.message,
      ...(error.details && { details: error.details }),
      ...(requestId && { requestId }),
    });
  }
  logger.error('Unhandled error', { error });
  return errorResponse(500, {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
    ...(requestId && { requestId }),
  });
};
