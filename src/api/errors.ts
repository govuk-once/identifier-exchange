import { z } from 'zod';
import type { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Every error the API returns has this shape, whether API Gateway rejects the
 * request at the edge (see cdk/lib/api/gateway-responses.ts) or a handler
 * returns it.
 */
export const apiErrorResponse = z.object({
  code: z.string(),
  message: z.string(),
  details: z.array(z.string()).optional(),
  requestId: z.string().optional(),
});

export type ApiError = z.infer<typeof apiErrorResponse>;

export const jsonResponse = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const errorResponse = (statusCode: number, error: ApiError): APIGatewayProxyResult =>
  jsonResponse(statusCode, error);

/** One readable line per Zod issue, e.g. `id: Item ID must be a valid UUID`. */
export const describeIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  );
