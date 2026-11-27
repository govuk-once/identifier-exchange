import { sql } from 'drizzle-orm';
import type { MigrationDb } from '../migrator/types.js';

// DSQL rules for migrations:
// - One statement per db.execute(): each runs in its own transaction, and
//   DSQL allows only one DDL statement per transaction.
// - Make every statement idempotent (IF NOT EXISTS / IF EXISTS). A failure
//   part-way leaves earlier statements applied, and the next run starts the
//   migration again from the top.
// - Create indexes with CREATE INDEX ASYNC; the executor waits for the job.
// - down() must undo up(), in reverse order.
// - DDL cannot take bind parameters: use sql.identifier() for names, not a
//   plain ${value} (which becomes $1).
// - Identity columns and sequences need an explicit CACHE of 1 or >= 65536.
//
// The reference schema is src/db/schema/identifier_attributes.sql; keep the
// two in step (identifier-attributes.schema.test.ts checks).
//
// linked_identifier_id refers to linked_identifiers.id, but DSQL has no
// foreign key constraints, so there is no REFERENCES clause.

export const TABLE_NAME = 'identifier_attributes';
const table = sql.identifier(TABLE_NAME);

const INDEXES = [
  'idx_identifier_attributes_linked_id_name',
  'idx_identifier_attributes_linked_identifier_id',
] as const;

/** Database roles created by 20261112101658_grant_user_permissions. */
const GRANTS = [
  { role: 'readwrite_role', privileges: sql.raw('SELECT, INSERT, UPDATE, DELETE') },
  { role: 'readonly_role', privileges: sql.raw('SELECT') },
] as const;

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ${table} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    linked_identifier_id UUID NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    data_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await db.execute(sql`CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_identifier_attributes_linked_id_name
    ON ${table} (linked_identifier_id, name)`);

  await db.execute(sql`CREATE INDEX ASYNC IF NOT EXISTS idx_identifier_attributes_linked_identifier_id
    ON ${table} (linked_identifier_id)`);

  for (const { role, privileges } of GRANTS) {
    await db.execute(sql`GRANT ${privileges} ON ${table} TO ${sql.identifier(role)}`);
  }
}

export async function down(db: MigrationDb): Promise<void> {
  // Dropping the table also drops its privileges, so there is nothing to
  // REVOKE (and REVOKE would fail on a re-run once the table is gone).
  for (const index of INDEXES.toReversed()) {
    await db.execute(sql`DROP INDEX IF EXISTS ${sql.identifier(index)}`);
  }
  await db.execute(sql`DROP TABLE IF EXISTS ${table}`);
}
