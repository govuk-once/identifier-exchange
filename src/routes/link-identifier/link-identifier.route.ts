import { z } from 'zod';
import { apiErrorResponse } from '../../api/errors.js';
import { IDX_DOMAIN } from '../../db/linked-identifiers/linked-identifier.js';
import { defineRoute } from './../define-route.js';

// Anchor rows (linked_domain 'IdX') are only ever created by the link query.
const notIdx = (field: string) =>
  z
    .string()
    .min(1)
    .refine((value) => value !== IDX_DOMAIN, {
      message: `${field} cannot be ${IDX_DOMAIN}: anchors are created by the API`,
    });

// 1. Input validation schemas
export const linkIdentifierRequestBody = z.object({
  domain: notIdx('domain'),
  domainId: z.uuid({ message: 'domainId must be a valid UUID' }),
  linkedDomain: notIdx('linkedDomain'),
  linkedDomainId: z.uuid({ message: 'linkedDomainId must be a valid UUID' }),
  scope: z.string().min(1).optional(),
  scopeId: z.string().min(1).optional(),
  /**
   * Saved encrypted in identifier_attributes, one row per key. Strings are
   * stored as they are; objects as JSON.
   */
  attributes: z
    .record(z.string().min(1), z.union([z.string(), z.record(z.string(), z.unknown())]))
    .optional(),
});

export type LinkIdentifierRequest = z.infer<typeof linkIdentifierRequestBody>;

// 2. Output response schemas
export const linkedIdentifierResponse = z.object({
  id: z.uuid(),
  domain: z.string(),
  domainId: z.uuid(),
  linkedDomain: z.string(),
  linkedDomainId: z.uuid(),
  scope: z.string().nullable(),
  scopeId: z.string().nullable(),
  idxId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

// 3. Route
export const linkIdentifierRoute = defineRoute({
  operationId: 'linkIdentifier',
  method: 'PUT',
  path: '/link',
  summary: 'Link two identifiers, idempotently',
  handler: {
    entry: 'src/routes/link-identifier/link-identifier.handler.ts',
    databaseAccess: 'readwrite',
  },
  request: {
    body: linkIdentifierRequestBody,
  },
  responses: {
    200: { description: 'The link already existed', schema: linkedIdentifierResponse },
    201: { description: 'The link was created', schema: linkedIdentifierResponse },
    400: { description: 'Invalid request body', schema: apiErrorResponse },
    401: { description: 'Missing or invalid authentication token', schema: apiErrorResponse },
    403: { description: 'Missing or invalid SigV4 signature', schema: apiErrorResponse },
    500: { description: 'Unexpected error', schema: apiErrorResponse },
  },
});
