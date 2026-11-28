import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiErrorResponse } from '../../api/errors.js';
import type * as DsqlClientsModule from '../../db/dsql-clients.js';
import { IdentifierAttributeDto } from '../../db/identifier-attributes/identifier-attribute.js';
import { exchangeIdentifierSuccessResponse } from './exchange-identifier.route.js';

const KEY_ARN = 'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const DVLA_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const IDX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINK_ID = '0f0e0d0c-0b0a-4909-8807-060504030201';
const ATTRIBUTE_ID = '2f0e0d0c-0b0a-4909-8807-060504030201';

// The handler builds its pools and KMS client at import, so the environment
// and the pool factory have to be in place first.
const db = vi.hoisted(() => {
  process.env['CLUSTER_ENDPOINT'] = 'cluster.dsql.eu-west-2.on.aws';
  process.env['DATA_ENCRYPTION_KEY_ARN'] =
    'arn:aws:kms:eu-west-2:123456789012:key/11111111-2222-3333-4444-555555555555';
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

vi.mock('../../db/dsql-clients.js', async (importOriginal) => ({
  ...(await importOriginal<typeof DsqlClientsModule>()),
  createDsqlClients: db.createDsqlClients,
}));

// Stands in for KMS, as in identifier-attribute.dto.test.ts: Decrypt returns
// the data key only for the same KeyId and encryption context.
const wrapped = new Map<string, { key: Buffer; keyId: string; context: unknown }>();
const kmsSend = vi.spyOn(KMSClient.prototype, 'send').mockImplementation((async (
  command: unknown,
) => {
  if (command instanceof GenerateDataKeyCommand) {
    const key = randomBytes(32);
    const blob = randomUUID();
    wrapped.set(blob, {
      key,
      keyId: command.input.KeyId ?? '',
      context: command.input.EncryptionContext,
    });
    return { Plaintext: new Uint8Array(key), CiphertextBlob: Buffer.from(blob) };
  }
  if (command instanceof DecryptCommand) {
    const entry = wrapped.get(Buffer.from(command.input.CiphertextBlob ?? []).toString());
    if (
      !entry ||
      entry.keyId !== command.input.KeyId ||
      !isDeepStrictEqual(entry.context, command.input.EncryptionContext)
    ) {
      throw new Error('InvalidCiphertextException');
    }
    return { Plaintext: new Uint8Array(entry.key) };
  }
  throw new Error('unexpected command');
}) as never);

const encryptor = new IdentifierAttributeDto({ kms: new KMSClient({}), keyId: KEY_ARN });

const { handler } = await import('./exchange-identifier.handler.js');

const lambdaContext = { awsRequestId: 'aws-request-1' } as Context;

const event = (pathParameters: Record<string, string> | null) =>
  ({
    body: null,
    pathParameters,
    queryStringParameters: null,
    requestContext: { requestId: 'request-1' },
  }) as unknown as APIGatewayProxyEvent;

const body = (result: { body: string }) => JSON.parse(result.body) as unknown;

/** A stored App <-> DVLA link, as the exchange query returns it for `target`. */
const linkRow = (target: 'App' | 'DVLA', attribute?: Record<string, unknown>) => ({
  id: LINK_ID,
  domain: 'App',
  domain_id: APP_ID,
  linked_domain: 'DVLA',
  linked_domain_id: DVLA_ID,
  scope: null,
  scope_id: null,
  idx_id: IDX_ID,
  created_at: new Date('2026-11-26T12:00:00Z'),
  exchanged_id: target === 'DVLA' ? DVLA_ID : APP_ID,
  exchanged_domain: target,
  attribute_id: null,
  attribute_name: null,
  attribute_value: null,
  attribute_data_key: null,
  attribute_created_at: null,
  ...attribute,
});

beforeEach(() => {
  db.statements.length = 0;
  db.state.rows = [];
  db.state.error = undefined;
  db.release.mockClear();
  db.pool.connect.mockClear();
  kmsSend.mockClear();
});

describe('exchangeIdentifier handler', () => {
  test('creates only a read client, bound to the cluster endpoint', () => {
    expect(db.createDsqlClients).toHaveBeenCalledWith(['read'], {
      host: 'cluster.dsql.eu-west-2.on.aws',
    });
  });

  test('rejects a domainId that is not a UUID without touching the database', async () => {
    const result = await handler(
      event({ domain: 'App', domainId: 'not-a-uuid', linkedDomain: 'DVLA' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(400);
    expect(apiErrorResponse.parse(body(result))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Invalid request',
      details: ['domainId: domainId must be a valid UUID'],
      requestId: 'request-1',
    });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('rejects missing path parameters', async () => {
    const result = await handler(event(null), lambdaContext);

    expect(result.statusCode).toBe(400);
  });

  test('returns 404 when there is no group or no link to the target, after rolling back', async () => {
    const result = await handler(
      event({ domain: 'App', domainId: APP_ID, linkedDomain: 'HMRC' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(404);
    expect(apiErrorResponse.parse(body(result))).toEqual({
      code: 'NOT_FOUND',
      message: `No HMRC identifier linked to App identifier ${APP_ID}`,
      requestId: 'request-1',
    });
    expect(db.statements.map(({ sql }) => sql.trim().split(/\s/)[0])).toEqual([
      'BEGIN',
      'WITH',
      'ROLLBACK',
    ]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  test('exchanges forward (App -> DVLA), binding the path parameters', async () => {
    db.state.rows = [linkRow('DVLA')];

    const result = await handler(
      event({ domain: 'App', domainId: APP_ID, linkedDomain: 'DVLA' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(200);
    expect(db.statements[1]?.params).toEqual(['App', APP_ID, 'DVLA']);
    expect(db.statements.at(-1)?.sql).toBe('COMMIT');
    expect(exchangeIdentifierSuccessResponse.parse(body(result))).toEqual({
      domain: 'App',
      domainId: APP_ID,
      linkedDomain: 'DVLA',
      linkedIdentifiers: [
        {
          id: LINK_ID,
          domain: 'App',
          domainId: APP_ID,
          linkedDomain: 'DVLA',
          linkedDomainId: DVLA_ID,
          scope: null,
          scopeId: null,
          idxId: IDX_ID,
          createdAt: '2026-11-26T12:00:00.000Z',
          exchangedId: DVLA_ID,
          exchangedDomain: 'DVLA',
          attributes: [],
        },
      ],
    });
    expect(kmsSend).not.toHaveBeenCalled();
  });

  test('exchanges in reverse (DVLA -> App) from the same link row', async () => {
    db.state.rows = [linkRow('App')];

    const result = await handler(
      event({ domain: 'DVLA', domainId: DVLA_ID, linkedDomain: 'App' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(200);
    expect(db.statements[1]?.params).toEqual(['DVLA', DVLA_ID, 'App']);
    expect(body(result)).toMatchObject({
      linkedIdentifiers: [{ exchangedId: APP_ID, exchangedDomain: 'App' }],
    });
  });

  test('returns decrypted attributes without their ciphertext or data key', async () => {
    const encrypted = await encryptor.encryptValue(LINK_ID, 'drivingLicence', 'ELLIS801234AB9CD');
    db.state.rows = [
      linkRow('DVLA', {
        attribute_id: ATTRIBUTE_ID,
        attribute_name: 'drivingLicence',
        attribute_value: encrypted.value,
        attribute_data_key: encrypted.dataKey,
        attribute_created_at: new Date('2026-11-26T12:30:00Z'),
      }),
    ];

    const result = await handler(
      event({ domain: 'App', domainId: APP_ID, linkedDomain: 'DVLA' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(200);
    expect(body(result)).toMatchObject({
      linkedIdentifiers: [
        {
          attributes: [
            {
              id: ATTRIBUTE_ID,
              name: 'drivingLicence',
              value: 'ELLIS801234AB9CD',
              createdAt: '2026-11-26T12:30:00.000Z',
            },
          ],
        },
      ],
    });
    expect(result.body).not.toContain(encrypted.value);
    expect(result.body).not.toContain(encrypted.dataKey);
  });

  test('returns a generic 500 when an attribute fails to decrypt', async () => {
    db.state.rows = [
      linkRow('DVLA', {
        attribute_id: ATTRIBUTE_ID,
        attribute_name: 'drivingLicence',
        attribute_value: randomBytes(40).toString('base64'),
        attribute_data_key: Buffer.from('unknown-key').toString('base64'),
        attribute_created_at: new Date('2026-11-26T12:30:00Z'),
      }),
    ];

    const result = await handler(
      event({ domain: 'App', domainId: APP_ID, linkedDomain: 'DVLA' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(500);
    expect(apiErrorResponse.parse(body(result))).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(result.body).not.toContain('Ciphertext');
  });

  test('returns a generic 500 when the query fails', async () => {
    db.state.error = Object.assign(new Error('permission denied for table linked_identifiers'), {
      code: '42501',
    });

    const result = await handler(
      event({ domain: 'App', domainId: APP_ID, linkedDomain: 'DVLA' }),
      lambdaContext,
    );

    expect(result.statusCode).toBe(500);
    expect(apiErrorResponse.parse(body(result))).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(result.body).not.toContain('permission');
  });
});
