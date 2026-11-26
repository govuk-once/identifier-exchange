import { sql } from 'drizzle-orm';
import { roleArnLiteral, roleExists } from '../migrator/roles.js';
import type { MigrationDb } from '../migrator/types.js';
import { TABLE_NAME as IDENTIFIER_ATTRIBUTES } from './20261126152208_create_identifier_attributes.js';
import { TABLE_NAME as LINKED_IDENTIFIERS } from './20261126141927_create_linked_identifiers.js';

// DSQL rules for migrations:
// - One statement per db.execute(): each runs in its own transaction, and
//   DSQL allows only one DDL statement per transaction.
// - Make every statement idempotent (IF NOT EXISTS / IF EXISTS). A failure
//   part-way leaves earlier statements applied, and the next run starts the
//   migration again from the top.
// - Create indexes with CREATE INDEX ASYNC; the executor waits for the job.
// - down() must undo up(), in reverse order.
// - DDL cannot take bind parameters: use sql.identifier() for names and a
//   validated literal for IAM ARNs.
// - Identity columns and sequences need an explicit CACHE of 1 or >= 65536.
//
// Makes delete_role the only role that can DELETE from these tables: it gets
// SELECT, DELETE (Postgres needs SELECT for a DELETE with a WHERE clause) and
// readwrite_role loses DELETE. DataMigratorStack maps DeleteDbRole onto it.
// GRANT and REVOKE are idempotent, so a re-run is safe.

export const ROLE_NAME = 'delete_role';
const deleteRole = sql.identifier(ROLE_NAME);
const readWriteRole = sql.identifier('readwrite_role');
const ARN_ENV_VAR = 'DELETE_ROLE_ARN';

const TABLES = [LINKED_IDENTIFIERS, IDENTIFIER_ATTRIBUTES] as const;

export async function up(db: MigrationDb): Promise<void> {
  // Read the ARN before changing anything, so a missing variable fails fast.
  const arn = roleArnLiteral(ARN_ENV_VAR);

  if (!(await roleExists(db, ROLE_NAME))) {
    await db.execute(sql`CREATE ROLE ${deleteRole} WITH LOGIN`);
  }
  await db.execute(sql`AWS IAM GRANT ${deleteRole} TO ${arn}`);

  for (const name of TABLES) {
    const table = sql.identifier(name);
    // Grant before revoking, so deletes always have a role that can run them.
    await db.execute(sql`GRANT SELECT, DELETE ON ${table} TO ${deleteRole}`);
    await db.execute(sql`REVOKE DELETE ON ${table} FROM ${readWriteRole}`);
  }
}

export async function down(db: MigrationDb): Promise<void> {
  const arn = roleArnLiteral(ARN_ENV_VAR);

  for (const name of TABLES.toReversed()) {
    await db.execute(sql`GRANT DELETE ON ${sql.identifier(name)} TO ${readWriteRole}`);
  }

  if (!(await roleExists(db, ROLE_NAME))) {
    return;
  }
  for (const name of TABLES.toReversed()) {
    await db.execute(sql`REVOKE SELECT, DELETE ON ${sql.identifier(name)} FROM ${deleteRole}`);
  }
  await db.execute(sql`AWS IAM REVOKE ${deleteRole} FROM ${arn}`);
  await db.execute(sql`DROP ROLE IF EXISTS ${deleteRole}`);
}
