import { sql } from 'drizzle-orm';
import type { MigrationDb } from '../migrator/types.js';
import { TABLE_NAME } from './20261112100123_create_initial_tables.js';

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

const READ_WRITE_ROLE = 'read-write-db-role';
const READ_ONLY_ROLE = 'read-only-db-role';

export async function up(_db: MigrationDb): Promise<void> {
  await _db.execute(sql`CREATE ROLE ${READ_WRITE_ROLE} WITH LOGIN`);
  await _db.execute(sql`AWS IAM GRANT ${READ_WRITE_ROLE} TO ${process.env.READ_WRITE_ROLE_ARN}`);
  await _db.execute(
    sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE_NAME} TO ${READ_WRITE_ROLE}`,
  );

  await _db.execute(sql`CREATE ROLE ${READ_ONLY_ROLE} WITH LOGIN`);
  await _db.execute(sql`AWS IAM GRANT ${READ_ONLY_ROLE} TO ${process.env.READ_ONLY_ROLE_ARN}`);
  await _db.execute(sql`GRANT SELECT ON ${TABLE_NAME} TO ${READ_ONLY_ROLE}`);
}

export async function down(_db: MigrationDb): Promise<void> {
  await _db.execute(sql`AWS IAM REVOKE ${READ_WRITE_ROLE} TO ${process.env.READ_WRITE_ROLE_ARN}`);
  await _db.execute(
    sql`REVOKE SELECT, INSERT, UPDATE, DELETE ON ${TABLE_NAME} TO ${READ_WRITE_ROLE}`,
  );
  await _db.execute(sql`DROP ROLE ${READ_WRITE_ROLE}`);

  await _db.execute(sql`AWS IAM REVOKE ${READ_ONLY_ROLE} TO ${process.env.READ_ONLY_ROLE_ARN}`);

  await _db.execute(sql`REVOKE SELECT ON ${TABLE_NAME} TO ${READ_ONLY_ROLE}`);
  await _db.execute(sql`DROP ROLE ${READ_ONLY_ROLE}`);
}
