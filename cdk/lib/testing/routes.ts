import { z } from 'zod';
import { defineRoute } from '../../../src/routes/define-route.js';

/**
 * Routes for the CDK tests, so they do not depend on the API's real (or
 * example) routes.
 */
const handler = (databaseAccess: 'readonly' | 'readwrite') => ({
  entry: 'cdk/lib/testing/fixture.handler.ts',
  databaseAccess,
});

const apiError = z.object({ code: z.string(), message: z.string() });

export const getThingRoute = defineRoute({
  operationId: 'getThing',
  method: 'GET',
  path: '/things/{id}',
  summary: 'Fetch a thing',
  handler: handler('readonly'),
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({ expand: z.enum(['true', 'false']).optional() }),
    headers: z.object({ 'X-Correlation-Id': z.string().optional() }),
  },
  responses: {
    200: { description: 'The thing', schema: z.object({ id: z.uuid(), name: z.string() }) },
    404: { description: 'Not found', schema: apiError },
  },
});

export const createThingRoute = defineRoute({
  operationId: 'createThing',
  method: 'POST',
  path: '/things',
  summary: 'Create a thing',
  handler: handler('readwrite'),
  request: {
    headers: z.object({ 'Idempotency-Key': z.uuid() }),
    body: z.object({
      name: z.string().min(1),
      attributes: z.object({ colour: z.string() }).optional(),
      labels: z.looseObject({ team: z.string() }).optional(),
    }),
  },
  responses: { 201: { description: 'Created' } },
});

export const listThingsRoute = defineRoute({
  operationId: 'listThings',
  method: 'GET',
  path: '/things',
  summary: 'List things',
  handler: handler('readonly'),
  responses: { 200: { description: 'Things' } },
});

export const fixtureRoutes = [getThingRoute, createThingRoute, listThingsRoute];
