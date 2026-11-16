// cspell:words rolname
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
// - DDL cannot take bind parameters. A plain ${value} in sql`` becomes $1, so
//   use sql.identifier() for names and a validated literal for IAM ARNs.
// - Identity columns and sequences need an explicit CACHE of 1 or >= 65536.

const table = sql.identifier(TABLE_NAME);

/** Database roles; DataMigratorStack maps its IAM roles onto these. */
const ROLES = [
  {
    name: 'readwrite_role',
    arnEnvVar: 'READ_WRITE_ROLE_ARN',
    privileges: sql.raw('SELECT, INSERT, UPDATE, DELETE'),
  },
  {
    name: 'readonly_role',
    arnEnvVar: 'READ_ONLY_ROLE_ARN',
    privileges: sql.raw('SELECT'),
  },
] as const;

// Strict enough that the ARN can be inlined as a literal: no quotes possible.
const IAM_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

/**
 * The IAM role ARN from the migrator's environment (set by
 * DataMigratorStack), as a SQL string literal. AWS IAM GRANT/REVOKE take the
 * ARN as a literal, not a bind parameter.
 */
const roleArnLiteral = (envVar: string) => {
  const arn = process.env[envVar];
  if (!arn || !IAM_ROLE_ARN.test(arn)) {
    throw new Error(`${envVar} must be set to an IAM role ARN, got "${arn ?? ''}"`);
  }
  return sql.raw(`'${arn}'`);
};

/** Postgres has no CREATE ROLE IF NOT EXISTS, and DSQL has no DO blocks. */
const roleExists = async (db: MigrationDb, name: string) => {
  const { rows } = await db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${name}`);
  return rows.length > 0;
};

export async function up(db: MigrationDb): Promise<void> {
  for (const { name, arnEnvVar, privileges } of ROLES) {
    const role = sql.identifier(name);
    // Read the ARN before changing anything, so a missing variable fails fast.
    const arn = roleArnLiteral(arnEnvVar);

    if (!(await roleExists(db, name))) {
      await db.execute(sql`CREATE ROLE ${role} WITH LOGIN`);
    }
    await db.execute(sql`AWS IAM GRANT ${role} TO ${arn}`);
    await db.execute(sql`GRANT ${privileges} ON ${table} TO ${role}`);
  }
}

export async function down(db: MigrationDb): Promise<void> {
  for (const { name, arnEnvVar, privileges } of ROLES.toReversed()) {
    const role = sql.identifier(name);
    const arn = roleArnLiteral(arnEnvVar);

    if (!(await roleExists(db, name))) {
      continue;
    }
    await db.execute(sql`REVOKE ${privileges} ON ${table} FROM ${role}`);
    await db.execute(sql`AWS IAM REVOKE ${role} FROM ${arn}`);
    await db.execute(sql`DROP ROLE IF EXISTS ${role}`);
  }
}
