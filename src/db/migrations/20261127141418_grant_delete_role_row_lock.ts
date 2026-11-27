import { sql } from 'drizzle-orm';
import type { MigrationDb } from '../migrator/types.js';
import { TABLE_NAME as LINKED_IDENTIFIERS } from './20261126141927_create_linked_identifiers.js';
import { ROLE_NAME as DELETE_ROLE } from './20261126154805_add_delete_role.js';

// DSQL rules for migrations:
// - One statement per db.execute(): each runs in its own transaction, and
//   DSQL allows only one DDL statement per transaction.
// - Make every statement idempotent (IF NOT EXISTS / IF EXISTS). A failure
//   part-way leaves earlier statements applied, and the next run starts the
//   migration again from the top.
// - Create indexes with CREATE INDEX ASYNC; the executor waits for the job.
// - down() must undo up(), in reverse order.
// - DDL cannot take bind parameters: use sql.identifier() for names.
// - Identity columns and sequences need an explicit CACHE of 1 or >= 65536.
//
// Lets delete_role run SELECT ... FOR UPDATE on linked_identifiers, which
// Postgres allows only with UPDATE privilege. The unlink handler locks the
// IdX anchor row that way: in DSQL, FOR UPDATE puts the row in the
// transaction's commit-time conflict check, so two concurrent unlinks of the
// last links of one anchor conflict (and one retries) instead of both seeing
// another link remaining and leaving the anchor orphaned. The handler never
// issues an UPDATE. GRANT and REVOKE are idempotent, so a re-run is safe.

const table = sql.identifier(LINKED_IDENTIFIERS);
const deleteRole = sql.identifier(DELETE_ROLE);

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`GRANT UPDATE ON ${table} TO ${deleteRole}`);
}

export async function down(db: MigrationDb): Promise<void> {
  await db.execute(sql`REVOKE UPDATE ON ${table} FROM ${deleteRole}`);
}
