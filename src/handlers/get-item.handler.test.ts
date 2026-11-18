import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, test } from 'vitest';
import { apiErrorResponse } from '../api/errors.js';
import { handler } from './get-item.handler.js';

const ITEM_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

const event = (
  pathParameters: Record<string, string> | null,
  queryStringParameters: Record<string, string> | null = null,
) =>
  ({
    pathParameters,
    queryStringParameters,
    requestContext: { requestId: 'request-1' },
  }) as unknown as APIGatewayProxyEvent;

const body = (result: { body: string }) => JSON.parse(result.body) as unknown;

describe('getItem handler', () => {
  test('rejects an ID that is not a UUID with the API error shape', async () => {
    const result = await handler(event({ id: 'not-a-uuid' }));

    expect(result.statusCode).toBe(400);
    expect(apiErrorResponse.parse(body(result))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Invalid request parameters',
      details: ['id: Item ID must be a valid UUID'],
      requestId: 'request-1',
    });
  });

  test('rejects an invalid query parameter', async () => {
    const result = await handler(event({ id: ITEM_ID }, { includeMetadata: 'yes' }));

    expect(result.statusCode).toBe(400);
    expect(body(result)).toMatchObject({ details: [expect.stringMatching(/^includeMetadata:/)] });
  });

  test('returns 404 for an unknown item', async () => {
    const result = await handler(event({ id: ITEM_ID }, { includeMetadata: 'true' }));

    expect(result.statusCode).toBe(404);
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(apiErrorResponse.parse(body(result))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
