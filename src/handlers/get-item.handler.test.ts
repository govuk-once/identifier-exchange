import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiErrorResponse } from '../api/errors.js';
import type * as DsqlClientsModule from '../db/dsql-clients.js';

const ITEM_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

// The handler builds its pools at import, so the environment and the pool
// factory have to be in place first.
const db = vi.hoisted(() => {
  process.env['CLUSTER_ENDPOINT'] = 'cluster.dsql.eu-west-2.on.aws';
  const statements: { sql: string; params?: unknown[] | undefined }[] = [];
  const state = { rows: [] as Record<string, unknown>[], error: undefined as Error | undefined };
  const release = vi.fn();
  const connection = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes('SELECT') && state.error) throw state.error;
      return { rows: sql.includes('SELECT') ? state.rows : [] };
    }),
    release,
  };
  const pool = { query: vi.fn(), connect: vi.fn(async () => connection) };
  return {
    statements,
    state,
    release,
    pool,
    createDsqlClients: vi.fn(() => ({ readClient: pool })),
  };
});

vi.mock('../db/dsql-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DsqlClientsModule>()),
  createDsqlClients: db.createDsqlClients,
}));

const { handler } = await import('./get-item.handler.js');

const lambdaContext = { awsRequestId: 'aws-request-1' } as Context;

const event = (
  pathParameters: Record<string, string> | null,
  queryStringParameters: Record<string, string> | null = null,
) =>
  ({
    body: null,
    pathParameters,
    queryStringParameters,
    requestContext: { requestId: 'request-1' },
  }) as unknown as APIGatewayProxyEvent;

const body = (result: { body: string }) => JSON.parse(result.body) as unknown;

beforeEach(() => {
  db.statements.length = 0;
  db.state.rows = [];
  db.state.error = undefined;
  db.release.mockClear();
});

describe('getItem handler', () => {
  test('creates only a read client, bound to the cluster endpoint', () => {
    expect(db.createDsqlClients).toHaveBeenCalledWith(['read'], {
      host: 'cluster.dsql.eu-west-2.on.aws',
    });
  });

  test('rejects an ID that is not a UUID without touching the database', async () => {
    const result = await handler(event({ id: 'not-a-uuid' }), lambdaContext);

    expect(result.statusCode).toBe(400);
    expect(apiErrorResponse.parse(body(result))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Invalid request',
      details: ['id: Item ID must be a valid UUID'],
      requestId: 'request-1',
    });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('rejects an invalid query parameter', async () => {
    const result = await handler(event({ id: ITEM_ID }, { includeMetadata: 'yes' }), lambdaContext);

    expect(result.statusCode).toBe(400);
    expect(body(result)).toMatchObject({ details: [expect.stringMatching(/^includeMetadata:/)] });
  });

  test('returns 404 for an unknown item, after rolling back', async () => {
    const result = await handler(
      event({ id: ITEM_ID }, { includeMetadata: 'true' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(404);
    expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(apiErrorResponse.parse(body(result))).toEqual({
      code: 'NOT_FOUND',
      message: `Item ${ITEM_ID} not found`,
      requestId: 'request-1',
    });
    expect(db.statements.map(({ sql }) => sql.split(/\s/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'ROLLBACK',
    ]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  test('queries by the ID as a bind parameter and returns the item', async () => {
    db.state.rows = [
      {
        id: ITEM_ID,
        name: 'example',
        status: 'active',
        created_at: new Date('2026-11-26T12:00:00Z'),
      },
    ];

    const result = await handler(event({ id: ITEM_ID }), lambdaContext);

    expect(result.statusCode).toBe(200);
    expect(body(result)).toEqual({
      id: ITEM_ID,
      name: 'example',
      status: 'active',
      createdAt: '2026-11-26T12:00:00.000Z',
    });
    expect(db.statements[1]?.params).toEqual([ITEM_ID]);
    expect(db.statements.at(-1)?.sql).toBe('COMMIT');
  });

  test('returns a generic 500 when the query fails', async () => {
    db.state.error = Object.assign(new Error('permission denied for table items'), {
      code: '42501',
    });

    const result = await handler(event({ id: ITEM_ID }), lambdaContext);

    expect(result.statusCode).toBe(500);
    expect(apiErrorResponse.parse(body(result))).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(result.body).not.toContain('permission');
  });
});
