import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiErrorResponse } from '../api/errors.js';
import type * as DsqlClientsModule from '../db/dsql-clients.js';
import type { LinkRow } from '../db/linked-identifiers/unlink-identifier.testing.js';
import { unlinkIdentifierSuccessResponse } from '../routes/unlink-identifier.route.js';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const IDX_ID = '22222222-2222-4222-8222-222222222222';
const DVLA_ID = '33333333-3333-4333-8333-333333333333';
const HMRC_ID = '44444444-4444-4444-8444-444444444444';

// The handler builds its pool at import, so the environment and the pool
// factory have to be in place first.
const db = vi.hoisted(async () => {
  process.env['CLUSTER_ENDPOINT'] = 'cluster.dsql.eu-west-2.on.aws';
  const { FakeLinkStore } = await import('../db/linked-identifiers/unlink-identifier.testing.js');
  const holder = { store: new FakeLinkStore() };
  // A stable pool whose calls go to the current store.
  const pool = {
    query: (sql: string, params?: unknown[]) => holder.store.pool.query(sql, params),
    connect: vi.fn(() => holder.store.pool.connect()),
  };
  return { holder, pool, createDsqlClients: vi.fn(() => ({ deleteClient: pool })) };
});

vi.mock('../db/dsql-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DsqlClientsModule>()),
  createDsqlClients: (await db).createDsqlClients,
}));

const { handler } = await import('./unlink-identifier.handler.js');
const { FakeLinkStore, pgError } =
  await import('../db/linked-identifiers/unlink-identifier.testing.js');
const { holder, pool, createDsqlClients } = await db;

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

const path = { domain: 'app', domainId: APP_ID, linkedDomain: 'dvla' };
const body = (result: { body: string }) => JSON.parse(result.body) as unknown;

const row = (id: string, fields: Partial<LinkRow> = {}): LinkRow => ({
  id,
  domain: 'app',
  domain_id: APP_ID,
  linked_domain: 'dvla',
  linked_domain_id: DVLA_ID,
  scope: null,
  scope_id: null,
  idx_id: IDX_ID,
  ...fields,
});
const anchor = row('anchor', { linked_domain: 'IdX', linked_domain_id: IDX_ID, idx_id: null });
const hmrc = row('hmrc-link', { linked_domain: 'hmrc', linked_domain_id: HMRC_ID });

const store = () => holder.store;

beforeEach(() => {
  holder.store = new FakeLinkStore();
  pool.connect.mockClear();
});

describe('unlinkIdentifier handler', () => {
  test('creates only a delete client, bound to the cluster endpoint', () => {
    expect(createDsqlClients).toHaveBeenCalledWith(['delete'], {
      host: 'cluster.dsql.eu-west-2.on.aws',
    });
  });

  describe('success', () => {
    test('unlinks an existing link and its attributes, keeping the anchor', async () => {
      store().links = [anchor, row('dvla-link'), hmrc];
      store().attributes = [{ id: 'a1', linked_identifier_id: 'dvla-link', name: 'licence' }];

      const result = await handler(event(path, { linkedDomainId: DVLA_ID }), lambdaContext);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(unlinkIdentifierSuccessResponse.parse(body(result))).toEqual({
        unlinked: true,
        anchorDeleted: false,
      });
      expect(store().links.map(({ id }) => id)).toEqual(['anchor', 'hmrc-link']);
      expect(store().attributes).toEqual([]);
    });

    test('removes the IdX anchor with the final link', async () => {
      store().links = [anchor, row('dvla-link')];

      const result = await handler(event(path), lambdaContext);

      expect(result.statusCode).toBe(200);
      expect(body(result)).toEqual({ unlinked: true, anchorDeleted: true });
      expect(store().links).toEqual([]);
    });

    test('returns 200 when the link is already absent', async () => {
      store().links = [anchor, hmrc];

      const result = await handler(event(path, { linkedDomainId: DVLA_ID }), lambdaContext);

      expect(result.statusCode).toBe(200);
      expect(body(result)).toEqual({ unlinked: true, anchorDeleted: false });
      expect(store().links).toEqual([anchor, hmrc]);
      expect(store().statementNames().at(-1)).toBe('COMMIT');
    });

    test('a repeated request gets the same 200', async () => {
      store().links = [anchor, row('dvla-link')];

      const first = await handler(event(path), lambdaContext);
      const second = await handler(event(path), lambdaContext);

      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(body(second)).toEqual({ unlinked: true, anchorDeleted: false });
    });

    test('passes the scope through to the query', async () => {
      store().links = [anchor, row('scoped', { scope: 'device', scope_id: 'd-1' }), hmrc];

      const result = await handler(event(path, { scope: 'device', scopeId: 'd-1' }), lambdaContext);

      expect(result.statusCode).toBe(200);
      expect(store().links.map(({ id }) => id)).toEqual(['anchor', 'hmrc-link']);
    });
  });

  describe('validation', () => {
    test.each([
      [{ ...path, domainId: 'not-a-uuid' }, null, 'domainId: domainId must be a valid UUID'],
      [path, { linkedDomainId: 'nope' }, 'linkedDomainId: linkedDomainId must be a valid UUID'],
      [
        { ...path, linkedDomain: 'IdX' },
        null,
        'linkedDomain: linkedDomain cannot be IdX: anchors are removed by the API',
      ],
      [
        { ...path, domain: 'IdX' },
        null,
        'domain: domain cannot be IdX: anchors are removed by the API',
      ],
      [path, { scopeId: 'd-1' }, 'scopeId: scopeId needs scope'],
      [path, { scope: '' }, expect.stringMatching(/^scope:/)],
    ])('rejects %o %o without touching the database', async (params, query, detail) => {
      const result = await handler(event(params, query), lambdaContext);

      expect(result.statusCode).toBe(400);
      expect(apiErrorResponse.parse(body(result))).toEqual({
        code: 'BAD_REQUEST',
        message: 'Invalid request',
        details: [detail],
        requestId: 'request-1',
      });
      expect(pool.connect).not.toHaveBeenCalled();
    });

    test('rejects missing path parameters', async () => {
      const result = await handler(event(null), lambdaContext);

      expect(result.statusCode).toBe(400);
      expect(pool.connect).not.toHaveBeenCalled();
    });
  });

  describe('DSQL conflicts and errors', () => {
    test.each(['OC000', 'OC001', '40001', '08006'])(
      'retries the whole transaction after %s, then succeeds',
      async (code) => {
        store().links = [anchor, row('dvla-link')];
        let failed = false;
        store().fail = (sql) => {
          if (sql === 'COMMIT' && !failed) {
            failed = true;
            return pgError(code);
          }
          return undefined;
        };

        const result = await handler(event(path), lambdaContext);

        expect(result.statusCode).toBe(200);
        expect(body(result)).toEqual({ unlinked: true, anchorDeleted: true });
        expect(pool.connect).toHaveBeenCalledTimes(2);
        expect(
          store()
            .statementNames()
            .filter((name) => name === 'BEGIN'),
        ).toHaveLength(2);
        expect(store().statementNames()).toContain('ROLLBACK');
        expect(store().links).toEqual([]);
      },
    );

    test('a retry after a concurrent unlink sees its deletion and removes the anchor', async () => {
      // Two links; a concurrent request removes hmrc-link and commits first,
      // so this request's first COMMIT conflicts on the locked anchor row.
      store().links = [anchor, row('dvla-link'), hmrc];
      let conflicted = false;
      store().fail = (sql) => {
        if (sql === 'COMMIT' && !conflicted) {
          conflicted = true;
          return pgError('OC000');
        }
        return undefined;
      };
      const rollback = store().connection.query;
      store().connection.query = async (sql, params) => {
        const result = await rollback(sql, params);
        if (sql === 'ROLLBACK') {
          store().links = store().links.filter(({ id }) => id !== 'hmrc-link');
        }
        return result;
      };

      const result = await handler(event(path), lambdaContext);

      expect(result.statusCode).toBe(200);
      expect(body(result)).toEqual({ unlinked: true, anchorDeleted: true });
      expect(store().links).toEqual([]);
    });

    test('returns a generic 500 once retries are exhausted, leaving the data untouched', async () => {
      store().links = [anchor, row('dvla-link')];
      store().fail = (sql) => (sql === 'COMMIT' ? pgError('OC000', 'change conflicts') : undefined);

      const result = await handler(event(path), lambdaContext);

      expect(result.statusCode).toBe(500);
      expect(apiErrorResponse.parse(body(result))).toEqual({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'request-1',
      });
      expect(pool.connect).toHaveBeenCalledTimes(3);
      expect(store().links.map(({ id }) => id)).toEqual(['anchor', 'dvla-link']);
    });

    test('does not retry a non-transient error, and does not leak it', async () => {
      store().links = [anchor, row('dvla-link')];
      store().fail = (sql) =>
        sql.startsWith('DELETE FROM identifier_attributes')
          ? pgError('42501', 'permission denied for table identifier_attributes')
          : undefined;

      const result = await handler(event(path), lambdaContext);

      expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain('permission');
      expect(pool.connect).toHaveBeenCalledOnce();
      // Rolled back: the link deleted earlier in the transaction is back.
      expect(store().links.map(({ id }) => id)).toEqual(['anchor', 'dvla-link']);
      expect(store().releases).toBe(1);
    });
  });
});
