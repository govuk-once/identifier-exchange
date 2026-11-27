import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDb } from '../migrator/testing.js';
import { down, up } from './20261126154805_add_delete_role.js';

const ARN = 'arn:aws:iam::123456789012:role/dev-identifier-exchange-dsql-delete';

/** A FakeDb in which delete_role does or doesn't already exist. */
const db = (roleExists: boolean) =>
  new FakeDb((sql) => (roleExists && sql.includes('pg_roles') ? [{ '?column?': 1 }] : []));

const changes = (fake: FakeDb) => fake.migrationStatements.filter((s) => !s.includes('pg_roles'));

describe('20261126154805_add_delete_role', () => {
  beforeEach(() => {
    vi.stubEnv('DELETE_ROLE_ARN', ARN);
    return () => vi.unstubAllEnvs();
  });

  test('up() creates delete_role, gives it DELETE and takes DELETE from readwrite_role', async () => {
    const fake = db(false);
    await up(fake);

    expect(changes(fake)).toEqual([
      'CREATE ROLE "delete_role" WITH LOGIN',
      `AWS IAM GRANT "delete_role" TO '${ARN}'`,
      'GRANT SELECT, DELETE ON "linked_identifiers" TO "delete_role"',
      'REVOKE DELETE ON "linked_identifiers" FROM "readwrite_role"',
      'GRANT SELECT, DELETE ON "identifier_attributes" TO "delete_role"',
      'REVOKE DELETE ON "identifier_attributes" FROM "readwrite_role"',
    ]);
  });

  test('up() re-run does not create the role again', async () => {
    const fake = db(true);
    await up(fake);

    expect(changes(fake)).not.toContain('CREATE ROLE "delete_role" WITH LOGIN');
  });

  test('down() gives DELETE back to readwrite_role, then removes delete_role', async () => {
    const fake = db(true);
    await down(fake);

    expect(changes(fake)).toEqual([
      'GRANT DELETE ON "identifier_attributes" TO "readwrite_role"',
      'GRANT DELETE ON "linked_identifiers" TO "readwrite_role"',
      'REVOKE SELECT, DELETE ON "identifier_attributes" FROM "delete_role"',
      'REVOKE SELECT, DELETE ON "linked_identifiers" FROM "delete_role"',
      `AWS IAM REVOKE "delete_role" FROM '${ARN}'`,
      'DROP ROLE IF EXISTS "delete_role"',
    ]);
  });

  test('down() with delete_role already gone only restores readwrite_role', async () => {
    const fake = db(false);
    await down(fake);

    expect(changes(fake)).toEqual([
      'GRANT DELETE ON "identifier_attributes" TO "readwrite_role"',
      'GRANT DELETE ON "linked_identifiers" TO "readwrite_role"',
    ]);
  });

  test('fails before changing anything if DELETE_ROLE_ARN is missing', async () => {
    vi.stubEnv('DELETE_ROLE_ARN', '');
    const fake = db(false);

    await expect(up(fake)).rejects.toThrow('DELETE_ROLE_ARN');
    expect(fake.statements).toEqual([]);
  });
});
