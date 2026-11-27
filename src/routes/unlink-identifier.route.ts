import { z } from 'zod';
import { apiErrorResponse } from '../api/errors.js';
import { IDX_DOMAIN } from '../db/linked-identifiers/linked-identifier.js';
import { defineRoute } from './define-route.js';

// IdX anchors are removed with their last link, never unlinked directly.
const notIdx = (field: string) =>
  z
    .string()
    .min(1)
    .refine((value) => value !== IDX_DOMAIN, {
      message: `${field} cannot be ${IDX_DOMAIN}: anchors are removed by the API`,
    });

// 1. Input validation schemas
export const unlinkIdentifierPathParams = z.object({
  domain: notIdx('domain'),
  domainId: z.uuid({ message: 'domainId must be a valid UUID' }),
  linkedDomain: notIdx('linkedDomain'),
});

/**
 * Optional narrowing of which links to remove. API Gateway paths cannot have
 * optional segments, so these are query parameters. An omitted one matches
 * any value: without linkedDomainId every link from the identifier to
 * linkedDomain is removed.
 */
export const unlinkIdentifierQueryParams = z
  .object({
    linkedDomainId: z.uuid({ message: 'linkedDomainId must be a valid UUID' }).optional(),
    scope: z.string().min(1).optional(),
    scopeId: z.string().min(1).optional(),
  })
  .refine((query) => query.scopeId === undefined || query.scope !== undefined, {
    message: 'scopeId needs scope',
    path: ['scopeId'],
  });

// 2. Output response schemas
export const unlinkIdentifierSuccessResponse = z.object({
  /** Always true: no matching link exists after the call. */
  unlinked: z.literal(true),
  /** True when this call removed the last link and so the IdX anchor. */
  anchorDeleted: z.boolean(),
});

export type UnlinkIdentifierResponse = z.infer<typeof unlinkIdentifierSuccessResponse>;

// 3. Route
export const unlinkIdentifierRoute = defineRoute({
  operationId: 'unlinkIdentifier',
  method: 'DELETE',
  path: '/unlink/{domain}/{domainId}/{linkedDomain}',
  summary: 'Remove links between identifiers, idempotently',
  handler: {
    entry: 'src/handlers/unlink-identifier.handler.ts',
    databaseAccess: 'delete',
  },
  request: {
    params: unlinkIdentifierPathParams,
    query: unlinkIdentifierQueryParams,
  },
  responses: {
    200: {
      description: 'The matching links are gone, whether this call removed them or not',
      schema: unlinkIdentifierSuccessResponse,
    },
    400: { description: 'Invalid path or query parameters', schema: apiErrorResponse },
    401: { description: 'Missing or invalid authentication token', schema: apiErrorResponse },
    403: { description: 'Missing or invalid SigV4 signature', schema: apiErrorResponse },
    500: { description: 'Unexpected error', schema: apiErrorResponse },
  },
});
