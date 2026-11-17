import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { routes } from '../../../src/routes/index.js';
import { createThingRoute, fixtureRoutes, getThingRoute } from '../testing/routes.js';
import { OPENAPI_SPEC_PATH, exchangeApiSpec } from './exchange-api-spec.js';
import { buildOpenApiSpec, serialiseOpenApiSpec } from './openapi.js';

const OPTIONS = { title: 'Test API', version: 'v1', stageName: 'v1' };

describe('docs/openapi.json', () => {
  test('matches the current route definitions (run `pnpm export:openapi`)', () => {
    expect(readFileSync(OPENAPI_SPEC_PATH, 'utf8')).toBe(serialiseOpenApiSpec(exchangeApiSpec()));
  });

  test('documents every deployed route', () => {
    const spec = exchangeApiSpec();
    for (const route of routes) {
      expect(spec.paths[route.path]?.[route.method.toLowerCase()]).toMatchObject({
        operationId: route.operationId,
      });
    }
  });
});

describe('buildOpenApiSpec', () => {
  const spec = buildOpenApiSpec(fixtureRoutes, OPTIONS);

  test('is an OpenAPI 3.0 document served under the stage', () => {
    expect(spec).toMatchObject({
      openapi: '3.0.3',
      info: { title: 'Test API', version: 'v1' },
      servers: [{ url: '/v1' }],
    });
  });

  test('describes path, query and header parameters from the Zod schemas', () => {
    expect(spec.paths['/things/{id}']?.['get']).toMatchObject({
      operationId: 'getThing',
      summary: 'Fetch a thing',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        {
          name: 'expand',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['true', 'false'] },
        },
        { name: 'X-Correlation-Id', in: 'header', required: false },
      ],
    });
    expect(spec.paths['/things']?.['post']).toMatchObject({
      parameters: [{ name: 'Idempotency-Key', in: 'header', required: true }],
    });
  });

  test('describes request bodies, closed like the gateway models, and response schemas', () => {
    expect(spec.paths['/things']?.['post']).toMatchObject({
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { minLength: 1 } },
            },
          },
        },
      },
      responses: { 201: { description: 'Created' } },
    });
    expect(spec.paths['/things/{id}']?.['get']).toMatchObject({
      responses: {
        200: {
          content: { 'application/json': { schema: { required: expect.arrayContaining(['id']) } } },
        },
        404: { description: 'Not found' },
      },
    });
  });

  test('uses OpenAPI 3.0 schemas, without a JSON Schema $schema', () => {
    expect(JSON.stringify(spec)).not.toContain('$schema');
  });

  test('requires SigV4 on every operation', () => {
    expect(spec.security).toEqual([{ sigv4: [] }]);
    expect(spec.components.securitySchemes['sigv4']).toMatchObject({
      'x-amazon-apigateway-authtype': 'awsSigv4',
    });
  });

  test('is independent of route order', () => {
    expect(serialiseOpenApiSpec(buildOpenApiSpec(fixtureRoutes.toReversed(), OPTIONS))).toBe(
      serialiseOpenApiSpec(spec),
    );
  });

  test('fails on a duplicate method and path', () => {
    expect(() => buildOpenApiSpec([getThingRoute, getThingRoute], OPTIONS)).toThrow(
      'Duplicate route: GET /things/{id}',
    );
  });

  test('fails on a schema OpenAPI cannot express', () => {
    expect(() =>
      buildOpenApiSpec(
        [{ ...createThingRoute, request: { body: z.object({ when: z.date() }) } }],
        OPTIONS,
      ),
    ).toThrow();
  });
});
