import { AuroraDSQLPool, isOCCError } from '@aws/aurora-dsql-node-postgres-connector';

// Role-bound Aurora DSQL pools, retry and transactions for API handlers.
//
// Each pool connects as one of the least-privilege database roles created by
// the migrations. The connector mints an IAM auth token per connection for
// that role, so the Lambda's IAM role must be the one mapped to it with
// `AWS IAM GRANT` (DataMigratorStack sets this up):
//
//   read   -> readonly_role   <- ReadOnlyDbRole
//   write  -> readwrite_role  <- ReadWriteDbRole
//   delete -> delete_role     <- DeleteDbRole
//
// A function runs as exactly one IAM role (the route's `databaseAccess`), so
// in practice a handler creates only the client for that role.

export type DsqlRole = 'read' | 'write' | 'delete';

export type QueryResultRow = Record<string, unknown>;

export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;
}

/** A connection with a transaction open on it. */
export type TxClient = Queryable;

/** The parts of a pg Pool that handlers and runInTransaction use. */
export interface RolePool extends Queryable {
  connect: () => Promise<Queryable & { release: (destroy?: boolean | Error) => void }>;
}

/** `['read', 'write']` -> `{ readClient: RolePool; writeClient: RolePool }`. */
export type DsqlClients<R extends DsqlRole = never> = { [K in R as `${K}Client`]: RolePool };

/**
 * Database roles from the migrations, keyed by client role. Written out rather
 * than imported so handler bundles do not pull in the migrations (and drizzle);
 * dsql-clients.test.ts checks they match.
 */
export const DSQL_ROLE_USERS: Readonly<Record<DsqlRole, string>> = {
  read: 'readonly_role',
  write: 'readwrite_role',
  delete: 'delete_role',
};

export interface CreateDsqlClientsOptions {
  /** Cluster endpoint (CLUSTER_ENDPOINT in ExchangeApiStack). */
  host: string;
  /** Override the database role per client; defaults to DSQL_ROLE_USERS. */
  roleUsers?: Partial<Record<DsqlRole, string>>;
  /** Connections per pool. Lambda handles one request at a time. */
  max?: number;
  idleTimeoutMillis?: number;
  /** For tests. */
  createPool?: (config: {
    host: string;
    user: string;
    max: number;
    idleTimeoutMillis: number;
  }) => RolePool;
}

const defaultCreatePool: NonNullable<CreateDsqlClientsOptions['createPool']> = (config) =>
  new AuroraDSQLPool(config);

/**
 * One pool per requested role, and none for the others. Pools do not connect
 * until first used, so create them at module scope and reuse them across
 * invocations.
 */
export const createDsqlClients = <const R extends DsqlRole>(
  roles: readonly R[],
  options: CreateDsqlClientsOptions,
): DsqlClients<R> => {
  const createPool = options.createPool ?? defaultCreatePool;
  const clients: Record<string, RolePool> = {};
  for (const role of new Set(roles)) {
    clients[`${role}Client`] = createPool({
      host: options.host,
      user: options.roleUsers?.[role] ?? DSQL_ROLE_USERS[role],
      max: options.max ?? 1,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 60_000,
    });
  }
  return clients as DsqlClients<R>;
};

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Besides the OCC conflicts (40001 / OC000 / OC001), retry when the server
 * dropped the connection or picked this transaction as a deadlock victim.
 */
const TRANSIENT_PG_CODES = new Set(['57P01', '08000', '08003', '08006', '40P01']);

export const isRetryableDsqlError = (error: unknown): boolean => {
  if (isOCCError(error)) {
    return true;
  }
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return TRANSIENT_PG_CODES.has(String(error.code));
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying with exponential backoff and jitter while it
 * fails with a retryable error. Anything else (including HttpError) is thrown
 * at once. `operation` may run more than once, so it must be idempotent.
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  retryOptions: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = retryOptions.maxAttempts ?? 3;
  const baseDelayMs = retryOptions.baseDelayMs ?? 150;
  const maxDelayMs = retryOptions.maxDelayMs ?? 1000;
  const sleep = retryOptions.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableDsqlError(error)) {
        throw error;
      }
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(backoff + Math.floor(Math.random() * 50));
    }
  }
};

export type RunInTransactionFn = <T>(
  pool: RolePool,
  work: (tx: TxClient) => Promise<T>,
  retryOptions?: RetryOptions,
) => Promise<T>;

/**
 * BEGIN, `work`, COMMIT on one connection, rolling back if anything throws.
 * The whole transaction is retried on OCC conflicts and transient errors
 * (DSQL reports conflicts at COMMIT), so `work` must be safe to repeat.
 *
 * To fail a request from inside `work`, throw an HttpError: the transaction
 * rolls back, it is not retried, and createApiHandler maps it to a response.
 */
export const runInTransaction: RunInTransactionFn = (pool, work, retryOptions) =>
  withRetry(async () => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is unusable; destroy it rather than return it to the pool.
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }, retryOptions);
