import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as KmsModule from '@aws-sdk/client-kms';
import { apiErrorResponse } from '../../api/errors.js';
import type * as DsqlClientsModule from '../../db/dsql-clients.js';
import { linkedIdentifierResponse } from './link-identifier.route.js';

const KEY_ARN = 'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555';
const DOMAIN_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const LINKED_DOMAIN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const LINK_ID = '0f0e0d0c-0b0a-4909-8807-060504030201';
const IDX_ID = '12345678-1234-4234-8234-123456789abc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The handler builds its pools and KMS client at import, so the environment
// and the factories have to be in place first.
const mocks = vi.hoisted(() => {
  process.env['CLUSTER_ENDPOINT'] = 'cluster.dsql.eu-west-2.on.aws';
  process.env['DATA_ENCRYPTION_KEY_ARN'] =
    'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555';
  const statements: { sql: string; params?: unknown[] | undefined }[] = [];
  const state = {
    /** One entry per execution of the link query: rows to return, or an error to throw. */
    linkResults: [] as (Record<string, unknown>[] | Error)[],
  };
  const release = vi.fn();
  const connection = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.trimStart().startsWith('WITH')) {
        const next = state.linkResults.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next };
      }
      return { rows: [] };
    }),
    release,
  };
  const pool = { query: vi.fn(), connect: vi.fn(async () => connection) };
  const kmsSend = vi.fn();
  return {
    statements,
    state,
    release,
    pool,
    kmsSend,
    createDsqlClients: vi.fn(() => ({ writeClient: pool })),
  };
});

vi.mock('../../db/dsql-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DsqlClientsModule>()),
  createDsqlClients: mocks.createDsqlClients,
}));

vi.mock('@aws-sdk/client-kms', async (importOriginal) => ({
  ...(await importOriginal<typeof KmsModule>()),
  KMSClient: class {
    send = mocks.kmsSend;
  },
}));

const { handler } = await import('./link-identifier.handler.js');

const lambdaContext = { awsRequestId: 'aws-request-1' } as Context;

const event = (body: unknown) =>
  ({
    body: JSON.stringify(body),
    pathParameters: null,
    queryStringParameters: null,
    requestContext: { requestId: 'request-1' },
  }) as unknown as APIGatewayProxyEvent;

const parse = (result: { body: string }) => JSON.parse(result.body) as unknown;

const request = {
  domain: 'app',
  domainId: DOMAIN_ID,
  linkedDomain: 'dvla',
  linkedDomainId: LINKED_DOMAIN_ID,
};

const linkRow = (created: boolean, overrides: Record<string, unknown> = {}) => ({
  id: LINK_ID,
  domain: 'app',
  domain_id: DOMAIN_ID,
  linked_domain: 'dvla',
  linked_domain_id: LINKED_DOMAIN_ID,
  scope: null,
  scope_id: null,
  idx_id: IDX_ID,
  created_at: new Date('2026-11-27T12:00:00Z'),
  created,
  ...overrides,
});

const linkQueries = () => mocks.statements.filter(({ sql }) => sql.trimStart().startsWith('WITH'));
const attributeInserts = () =>
  mocks.statements.filter(({ sql }) => sql.includes('INSERT INTO identifier_attributes'));
const verbs = () => mocks.statements.map(({ sql }) => sql.trimStart().split(/\s/)[0]);

beforeEach(() => {
  mocks.statements.length = 0;
  mocks.state.linkResults = [];
  mocks.release.mockClear();
  mocks.pool.connect.mockClear();
  mocks.kmsSend.mockReset();
  mocks.kmsSend.mockImplementation(async () => ({
    Plaintext: new Uint8Array(32).fill(7),
    CiphertextBlob: Buffer.from('wrapped-key'),
  }));
});

describe('linkIdentifier handler', () => {
  test('creates only a write client, bound to the cluster endpoint', () => {
    expect(mocks.createDsqlClients).toHaveBeenCalledWith(['write'], {
      host: 'cluster.dsql.eu-west-2.on.aws',
    });
  });

  test('rejects a domainId that is not a UUID without touching the database', async () => {
    const result = await handler(event({ ...request, domainId: 'nope' }), lambdaContext);

    expect(result.statusCode).toBe(400);
    expect(apiErrorResponse.parse(parse(result))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Invalid request',
      details: ['domainId: domainId must be a valid UUID'],
      requestId: 'request-1',
    });
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  test('refuses to link to IdX directly', async () => {
    const result = await handler(event({ ...request, linkedDomain: 'idx' }), lambdaContext);

    expect(result.statusCode).toBe(400);
    expect(parse(result)).toMatchObject({ details: [expect.stringMatching(/^linkedDomain:/)] });
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  test('returns 201 with the camelCase link when it was created', async () => {
    mocks.state.linkResults = [[linkRow(true)]];

    const result = await handler(event(request), lambdaContext);

    expect(result.statusCode).toBe(201);
    const body = linkedIdentifierResponse.parse(parse(result));
    expect(body).toEqual({
      id: LINK_ID,
      domain: 'app',
      domainId: DOMAIN_ID,
      linkedDomain: 'dvla',
      linkedDomainId: LINKED_DOMAIN_ID,
      scope: null,
      scopeId: null,
      idxId: IDX_ID,
      createdAt: '2026-11-27T12:00:00.000Z',
    });
    expect(verbs()).toEqual(['BEGIN', 'WITH', 'COMMIT']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  test('passes every value as a bind parameter, with a freshly minted idx_id', async () => {
    mocks.state.linkResults = [[linkRow(true, { scope: 'device', scope_id: 'device-1' })]];

    await handler(event({ ...request, scope: 'device', scopeId: 'device-1' }), lambdaContext);

    const [query] = linkQueries();
    expect(query?.params).toEqual([
      'app',
      DOMAIN_ID,
      'dvla',
      LINKED_DOMAIN_ID,
      'device',
      'device-1',
      expect.stringMatching(UUID),
    ]);
    expect(query?.sql).not.toContain(DOMAIN_ID);
  });

  test('sends a null scope and scope_id when they are omitted', async () => {
    mocks.state.linkResults = [[linkRow(true)]];

    await handler(event(request), lambdaContext);

    expect(linkQueries()[0]?.params?.slice(4, 6)).toEqual([null, null]);
  });

  test('returns 200 with the existing link when it already existed', async () => {
    mocks.state.linkResults = [[linkRow(false)]];

    const result = await handler(event(request), lambdaContext);

    expect(result.statusCode).toBe(200);
    expect(parse(result)).toMatchObject({ id: LINK_ID, idxId: IDX_ID });
    expect(parse(result)).not.toHaveProperty('created');
  });

  test('encrypts each attribute for the link and upserts them in one statement', async () => {
    mocks.state.linkResults = [[linkRow(true)]];

    const result = await handler(
      event({ ...request, attributes: { email: 'a@example.com', address: { postcode: 'SW1A' } } }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(201);
    expect(mocks.kmsSend).toHaveBeenCalledTimes(2);
    const contexts = mocks.kmsSend.mock.calls.map(
      ([command]) => (command as KmsModule.GenerateDataKeyCommand).input,
    );
    expect(contexts).toEqual([
      expect.objectContaining({
        KeyId: KEY_ARN,
        EncryptionContext: { linked_identifier_id: LINK_ID, name: 'email' },
      }),
      expect.objectContaining({
        KeyId: KEY_ARN,
        EncryptionContext: { linked_identifier_id: LINK_ID, name: 'address' },
      }),
    ]);

    const inserts = attributeInserts();
    expect(inserts).toHaveLength(1);
    const params = inserts[0]?.params ?? [];
    expect(params[0]).toBe(LINK_ID);
    expect([params[1], params[4]]).toEqual(['email', 'address']);
    // Only ciphertext reaches the database.
    expect(JSON.stringify(params)).not.toContain('a@example.com');
    expect(JSON.stringify(params)).not.toContain('SW1A');
    expect(params[3]).toBe(Buffer.from('wrapped-key').toString('base64'));
    expect(inserts[0]?.sql).toContain('ON CONFLICT (linked_identifier_id, name)');
    expect(verbs()).toEqual(['BEGIN', 'WITH', 'INSERT', 'COMMIT']);
  });

  test('saves attributes against the existing link on a repeat request', async () => {
    mocks.state.linkResults = [[linkRow(false)]];

    const result = await handler(event({ ...request, attributes: { a: 'b' } }), lambdaContext);

    expect(result.statusCode).toBe(200);
    expect(attributeInserts()[0]?.params?.[0]).toBe(LINK_ID);
  });

  test('writes no attributes when none are sent', async () => {
    mocks.state.linkResults = [[linkRow(true)]];

    await handler(event({ ...request, attributes: {} }), lambdaContext);

    expect(mocks.kmsSend).not.toHaveBeenCalled();
    expect(attributeInserts()).toHaveLength(0);
  });

  test('retries the whole transaction on an OCC conflict, minting a new idx_id', async () => {
    mocks.state.linkResults = [
      Object.assign(new Error('change conflicts with another transaction'), { code: 'OC000' }),
      [linkRow(false)],
    ];

    const result = await handler(event(request), lambdaContext);

    expect(result.statusCode).toBe(200);
    expect(verbs()).toEqual(['BEGIN', 'WITH', 'ROLLBACK', 'BEGIN', 'WITH', 'COMMIT']);
    const [first, second] = linkQueries();
    expect(first?.params?.[6]).not.toBe(second?.params?.[6]);
  });

  test('retries when the link conflicted with one it cannot see yet', async () => {
    mocks.state.linkResults = [[], [linkRow(false)]];

    const result = await handler(event(request), lambdaContext);

    expect(result.statusCode).toBe(200);
    expect(linkQueries()).toHaveLength(2);
  });

  test('returns a generic 500 and rolls back when KMS fails', async () => {
    mocks.state.linkResults = [[linkRow(true)]];
    mocks.kmsSend.mockRejectedValue(new Error('AccessDeniedException: kms:GenerateDataKey'));

    const result = await handler(event({ ...request, attributes: { a: 'b' } }), lambdaContext);

    expect(result.statusCode).toBe(500);
    expect(apiErrorResponse.parse(parse(result))).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(result.body).not.toContain('kms');
    expect(verbs()).toEqual(['BEGIN', 'WITH', 'ROLLBACK']);
    expect(attributeInserts()).toHaveLength(0);
  });

  test('returns a generic 500 once retries are exhausted', async () => {
    const conflict = () => Object.assign(new Error('conflict'), { code: 'OC000' });
    mocks.state.linkResults = [conflict(), conflict(), conflict()];

    const result = await handler(event(request), lambdaContext);

    expect(result.statusCode).toBe(500);
    expect(linkQueries()).toHaveLength(3);
  });
});
