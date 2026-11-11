import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { MigrationDb, MigrationStatus, QueryResult } from './types.js';

const dialect = new PgDialect();

/** Renders a drizzle `sql` template to text and bind parameters. */
export const render = (query: SQL) => dialect.sqlToQuery(query);

/**
 * In-memory stand-in for DSQL: records every statement and emulates the
 * `schema_migrations` table so the runner can be tested without a
 * cluster. Other statements are recorded and answered with no rows unless
 * `respond` says otherwise.
 */
export class FakeDb implements MigrationDb {
  readonly statements: { sql: string; params: unknown[] }[] = [];
  readonly tracking = new Map<string, MigrationStatus>();

  constructor(private readonly respond: (sql: string) => QueryResult['rows'] = () => []) {}

  async execute(query: SQL): Promise<QueryResult> {
    const { sql, params } = render(query);
    this.statements.push({ sql, params });

    if (/^\s*SELECT name, status FROM "schema_migrations"/.test(sql)) {
      return {
        rows: [...this.tracking.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, status]) => ({ name, status })),
      };
    }
    if (/^\s*INSERT INTO "schema_migrations"/.test(sql)) {
      this.tracking.set(params[0] as string, params[1] as MigrationStatus);
      return { rows: [] };
    }
    return { rows: this.respond(sql) };
  }

  /** Statements other than the runner's own bookkeeping. */
  get migrationStatements(): string[] {
    return this.statements
      .map((s) => s.sql.replace(/\s+/g, ' ').trim())
      .filter((s) => !s.includes('"schema_migrations"'));
  }
}
