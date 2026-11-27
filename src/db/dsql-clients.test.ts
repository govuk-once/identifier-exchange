import { describe, expect, test, vi } from 'vitest';
import {
  createDsqlClients,
  DSQL_ROLE_USERS,
  isRetryableDsqlError,
  type RolePool,
  runInTransaction,
  withRetry,
} from './dsql-clients.js';
import { NotFoundError } from '../api/http-errors.js';
import { ROLE_NAME as DELETE_ROLE } from './migrations/20261126154805_add_delete_role.js';

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });
const noSleep = { sleep: async () => {} };

/** A pool whose connection records statements; `fail` decides which ones throw. */
const fakePool = (fail: (sql: string, call: number) => Error | undefined = () => undefined) => {
  const statements: string[] = [];
  const release = vi.fn();
  let call = 0;
  const pool: RolePool = {
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        const error = fail(sql, call++);
        if (error) throw error;
        return { rows: [] };
      }),
      release,
    })),
  };
  return { pool, statements, release };
};

describe('createDsqlClients', () => {
  const createPool = vi.fn((config: { user: string }) => ({ config }) as unknown as RolePool);

  test('creates only the requested clients, each bound to its database role', () => {
    const clients = createDsqlClients(['read', 'delete'], { host: 'cluster.example', createPool });

    expect(Object.keys(clients).toSorted()).toEqual(['deleteClient', 'readClient']);
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(createPool).toHaveBeenCalledWith({
      host: 'cluster.example',
      user: 'readonly_role',
      max: 1,
      idleTimeoutMillis: 60_000,
    });
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ user: 'delete_role' }));
  });

  test('accepts role user overrides and pool settings', () => {
    createPool.mockClear();
    createDsqlClients(['write', 'write'], {
      host: 'h',
      roleUsers: { write: 'custom_role' },
      max: 3,
      idleTimeoutMillis: 5,
      createPool,
    });

    expect(createPool).toHaveBeenCalledOnce();
    expect(createPool).toHaveBeenCalledWith({
      host: 'h',
      user: 'custom_role',
      max: 3,
      idleTimeoutMillis: 5,
    });
  });

  test('role users match the roles the migrations create', () => {
    expect(DSQL_ROLE_USERS).toEqual({
      read: 'readonly_role',
      write: 'readwrite_role',
      delete: DELETE_ROLE,
    });
  });
});

describe('isRetryableDsqlError', () => {
  test.each(['40001', 'OC000', 'OC001', '57P01', '08006', '40P01'])('retries %s', (code) => {
    expect(isRetryableDsqlError(pgError(code))).toBe(true);
  });

  test.each([pgError('23505'), new Error('boom'), new NotFoundError(), null, 'OC000'])(
    'does not retry %s',
    (error) => {
      expect(isRetryableDsqlError(error)).toBe(false);
    },
  );
});

describe('withRetry', () => {
  test('returns the first success after retrying OCC conflicts', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(pgError('OC000'))
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValue('done');
    const sleep = vi.fn(async () => {});

    await expect(withRetry(operation, { sleep, baseDelayMs: 100, maxDelayMs: 150 })).resolves.toBe(
      'done',
    );
    expect(operation).toHaveBeenCalledTimes(3);
    // Exponential backoff capped at maxDelayMs, plus up to 50 ms of jitter.
    const [[first], [second]] = sleep.mock.calls as unknown as [[number], [number]];
    expect(first).toBeGreaterThanOrEqual(100);
    expect(first).toBeLessThan(150);
    expect(second).toBeGreaterThanOrEqual(150);
    expect(second).toBeLessThan(200);
  });

  test('gives up after maxAttempts', async () => {
    const operation = vi.fn().mockRejectedValue(pgError('OC001'));

    await expect(withRetry(operation, { ...noSleep, maxAttempts: 2 })).rejects.toMatchObject({
      code: 'OC001',
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test('throws a non-retryable error at once', async () => {
    const operation = vi.fn().mockRejectedValue(pgError('23505'));

    await expect(withRetry(operation, noSleep)).rejects.toMatchObject({ code: '23505' });
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('runInTransaction', () => {
  test('commits and returns what the work returns', async () => {
    const { pool, statements, release } = fakePool();

    const result = await runInTransaction(pool, async (tx) => {
      await tx.query('SELECT 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(release).toHaveBeenCalledWith(false);
  });

  test('rolls back and rethrows an HttpError without retrying', async () => {
    const { pool, statements, release } = fakePool();
    const work = vi.fn(async () => {
      throw new NotFoundError('LINK_NOT_FOUND', 'Link not found');
    });

    await expect(runInTransaction(pool, work, noSleep)).rejects.toBeInstanceOf(NotFoundError);
    expect(work).toHaveBeenCalledOnce();
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
  });

  test('rolls back and retries the whole transaction on an OCC conflict at COMMIT', async () => {
    const { pool, statements, release } = fakePool((sql, call) =>
      sql === 'COMMIT' && call === 2 ? pgError('OC000') : undefined,
    );

    const result = await runInTransaction(
      pool,
      async (tx) => (await tx.query('UPDATE t')).rows,
      noSleep,
    );

    expect(result).toEqual([]);
    expect(statements).toEqual([
      'BEGIN',
      'UPDATE t',
      'COMMIT',
      'ROLLBACK',
      'BEGIN',
      'UPDATE t',
      'COMMIT',
    ]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  test('destroys the connection when ROLLBACK fails, and keeps the original error', async () => {
    const { pool, release } = fakePool((sql) =>
      sql === 'ROLLBACK'
        ? new Error('connection terminated')
        : sql === 'SELECT 1'
          ? new Error('boom')
          : undefined,
    );

    await expect(
      runInTransaction(pool, async (tx) => tx.query('SELECT 1'), noSleep),
    ).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledWith(true);
  });
});
