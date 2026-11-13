import type { SQL } from 'drizzle-orm';

export interface QueryResult {
  rows: Record<string, unknown>[];
}

/**
 * What a migration receives. Each `execute` call must be a single SQL
 * statement: Aurora DSQL allows only one DDL statement per transaction, and
 * every call runs in its own (autocommit) transaction.
 *
 * Asynchronous DDL (`CREATE INDEX ASYNC`) is awaited before `execute`
 * resolves, so a later statement can rely on the index existing.
 */
export interface MigrationDb {
  execute(query: SQL): Promise<QueryResult>;
}

export interface MigrationModule {
  up(db: MigrationDb): Promise<void>;
  down(db: MigrationDb): Promise<void>;
}

export interface Migration extends MigrationModule {
  /** File name without extension, e.g. `20261106000001_create_exchanges`. */
  name: string;
}

export type MigrationStatus = 'running' | 'applied' | 'failed' | 'reverted';

export type MigrationRequest =
  | { action?: 'up' }
  | { action: 'down'; steps?: number }
  | { action: 'status' };

export interface MigrationReport {
  action: 'up' | 'down' | 'status';
  /** Migrations run by this invocation, in the order they ran. */
  ran: string[];
  applied: string[];
  pending: string[];
}
