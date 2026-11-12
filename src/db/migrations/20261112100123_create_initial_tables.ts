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
//
// e.g. await db.execute(sql`ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS ...`);

export const TABLE_NAME = 'identifiers';

export async function up(_db: MigrationDb): Promise<void> {
  await _db.execute(sql`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
     id BIGINT GENERATED Always AS IDENTITY PRIMARY KEY,
     anchor_id VARCHAR(255) NOT NULL,
     achor_alias VARCHAR(255) NOT NULL,
     link_id VARCHAR(255) NOT NULL,
     link_alias VARCHAR(255) NOT NULL,
     sub_id VARCHAR(255) NOT NULL
  )`);
}

export async function down(_db: MigrationDb): Promise<void> {
  await _db.execute(sql`DROP TABLE identifiers;`);
}
