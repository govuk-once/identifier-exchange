import { z } from 'zod';
import { apiErrorResponse } from '../api/errors.js';
import { defineRoute } from './define-route.js';

// 1. Input validation schemas
export const exchangeIdentifierPathParams = z.object({
  domain: z.string().min(1, { message: 'domain is required' }),
  domainId: z.uuid({ message: 'domainId must be a valid UUID' }),
  linkedDomain: z.string().min(1, { message: 'linkedDomain is required' }),
});

export type ExchangeIdentifierPathParams = z.infer<typeof exchangeIdentifierPathParams>;

// 2. Output response schemas
export const linkedAttributeResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Decrypted. */
  value: z.string(),
  createdAt: z.iso.datetime(),
});

export const exchangedIdentifierResponse = z.object({
  id: z.uuid(),
  domain: z.string(),
  domainId: z.uuid(),
  linkedDomain: z.string(),
  linkedDomainId: z.uuid(),
  scope: z.string().nullable(),
  scopeId: z.string().nullable(),
  idxId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** The identifier in the requested linkedDomain, whichever side of the link it is on. */
  exchangedId: z.uuid(),
  exchangedDomain: z.string(),
  attributes: z.array(linkedAttributeResponse),
});

export const exchangeIdentifierSuccessResponse = z.object({
  domain: z.string(),
  domainId: z.uuid(),
  linkedDomain: z.string(),
  /** Newest link first. */
  linkedIdentifiers: z.array(exchangedIdentifierResponse).min(1),
});

export type ExchangeIdentifierResponse = z.infer<typeof exchangeIdentifierSuccessResponse>;

// 3. Route
export const exchangeIdentifierRoute = defineRoute({
  operationId: 'exchangeIdentifier',
  method: 'GET',
  path: '/exchange/{domain}/{domainId}/{linkedDomain}',
  summary: 'Exchange an identifier for its linked identifier(s) in another domain',
  handler: {
    entry: 'src/handlers/exchange-identifier.handler.ts',
    databaseAccess: 'readonly',
  },
  request: {
    params: exchangeIdentifierPathParams,
  },
  responses: {
    200: {
      description: 'Linked identifier(s) in linkedDomain found in the caller’s idx_id group',
      schema: exchangeIdentifierSuccessResponse,
    },
    400: { description: 'Invalid path parameters', schema: apiErrorResponse },
    401: { description: 'Missing or invalid authentication credentials', schema: apiErrorResponse },
    403: { description: 'Missing or invalid SigV4 signature', schema: apiErrorResponse },
    404: {
      description: 'The identifier has no idx_id group, or no link to linkedDomain',
      schema: apiErrorResponse,
    },
    500: { description: 'Unexpected error', schema: apiErrorResponse },
  },
});
