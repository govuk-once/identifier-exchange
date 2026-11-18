import { z } from 'zod';
import { apiErrorResponse } from '../api/errors.js';
import { defineRoute } from './define-route.js';

// EXAMPLE ROUTE, not part of the real API contract. To remove it, see
// src/routes/index.ts.

// 1. Input validation schemas
export const getItemPathParams = z.object({
  id: z.uuid({ message: 'Item ID must be a valid UUID' }),
});

export const getItemQueryParams = z.object({
  includeMetadata: z.enum(['true', 'false']).optional(),
});

// 2. Output response schemas
export const getItemSuccessResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  createdAt: z.iso.datetime(),
});

export type GetItemResponse = z.infer<typeof getItemSuccessResponse>;

// 3. Route
export const getItemRoute = defineRoute({
  operationId: 'getItem',
  method: 'GET',
  path: '/items/{id}',
  summary: 'Retrieve item details by ID',
  handler: {
    entry: 'src/handlers/get-item.handler.ts',
    databaseAccess: 'readonly',
  },
  request: {
    params: getItemPathParams,
    query: getItemQueryParams,
  },
  responses: {
    200: { description: 'Successful retrieval of item', schema: getItemSuccessResponse },
    400: { description: 'Invalid path or query parameters', schema: apiErrorResponse },
    403: { description: 'Missing or invalid SigV4 signature', schema: apiErrorResponse },
    404: { description: 'Item not found', schema: apiErrorResponse },
    500: { description: 'Unexpected error', schema: apiErrorResponse },
  },
});
