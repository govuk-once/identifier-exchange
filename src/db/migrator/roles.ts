// cspell:words rolname
import { sql } from 'drizzle-orm';
import type { MigrationDb } from './types.js';

// Strict enough that the ARN can be inlined as a literal: no quotes possible.
const IAM_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/;

/**
 * The IAM role ARN in the migrator's environment variable `envVar` (set by
 * DataMigratorStack), as a SQL string literal. AWS IAM GRANT/REVOKE take the
 * ARN as a literal, not a bind parameter.
 */
export const roleArnLiteral = (envVar: string) => {
  const arn = process.env[envVar];
  if (!arn || !IAM_ROLE_ARN.test(arn)) {
    throw new Error(`${envVar} must be set to an IAM role ARN, got "${arn ?? ''}"`);
  }
  return sql.raw(`'${arn}'`);
};

/** Postgres has no CREATE ROLE IF NOT EXISTS, and DSQL has no DO blocks. */
export const roleExists = async (db: MigrationDb, name: string) => {
  const { rows } = await db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${name}`);
  return rows.length > 0;
};
