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
// - DDL cannot take bind parameters. A plain ${value} in sql`` becomes $1, so
//   use sql.identifier() for names (or write them inline).
// - Identity columns and sequences need an explicit CACHE of 1 or >= 65536.
//
// e.g. await db.execute(sql`ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS ...`);

export const TABLE_NAME = 'identifiers';
const table = sql.identifier(TABLE_NAME);

export async function up(db: MigrationDb): Promise<void> {
  // CACHE 65536 hands each connection a block of IDs: no write hot spot, but
  // IDs are unique rather than gap-free or strictly increasing.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ${table} (
     id BIGINT GENERATED ALWAYS AS IDENTITY (CACHE 65536) PRIMARY KEY,
     anchor_id VARCHAR(255) NOT NULL,
     anchor_alias VARCHAR(255) NOT NULL,
     link_id VARCHAR(255) NOT NULL,
     link_alias VARCHAR(255) NOT NULL,
     sub_id VARCHAR(255) NOT NULL
  )`);
}

export async function down(db: MigrationDb): Promise<void> {
  await db.execute(sql`DROP TABLE IF EXISTS ${table}`);
}
