import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { migrations } from './index.js';
import * as createDatabaseRoles from './20261106000003_create_database_roles.js';
import { FakeDb } from '../migrator/testing.js';
import { MigrationRunner } from '../migrator/runner.js';

const FILE_NAME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$/;

const migrationFiles = readdirSync(import.meta.dirname).filter(
  (file) => file !== 'index.ts' && !file.endsWith('.test.ts'),
);

const READ_ONLY_ROLE_ARN = 'arn:aws:iam::123456789012:role/dev-identifier-exchange-dsql-readonly';
const READ_WRITE_ROLE_ARN = 'arn:aws:iam::123456789012:role/dev-identifier-exchange-dsql-readwrite';

beforeEach(() => {
  process.env['READ_ONLY_ROLE_ARN'] = READ_ONLY_ROLE_ARN;
  process.env['READ_WRITE_ROLE_ARN'] = READ_WRITE_ROLE_ARN;
});
afterEach(() => {
  delete process.env['READ_ONLY_ROLE_ARN'];
  delete process.env['READ_WRITE_ROLE_ARN'];
});

describe('migration files', () => {
  test.each(migrationFiles)('%s is named <UTC yyyyMMddHHmmss>_<snake_case>.ts', (file) => {
    const match = FILE_NAME.exec(file);
    expect(match, `${file} does not match ${FILE_NAME}`).not.toBeNull();

    const [, y, mo, d, h, mi, s] = match!.map(Number);
    const date = new Date(Date.UTC(y!, mo! - 1, d, h, mi, s));
    // Round-tripping catches impossible dates such as month 13 or hour 25.
    expect(date.getUTCMonth() + 1).toBe(mo);
    expect(date.getUTCDate()).toBe(d);
    expect(date.getUTCHours()).toBe(h);
  });

  test('index.ts lists every migration file, in order', () => {
    expect(migrations.map((m) => `${m.name}.ts`)).toEqual([...migrationFiles].sort());
  });

  test.each(migrationFiles)('%s exports up(db) and down(db)', async (file) => {
    const module = (await import(`./${file}`)) as Record<string, unknown>;

    expect(module['up']).toBeTypeOf('function');
    expect(module['down']).toBeTypeOf('function');
    expect((module['up'] as () => unknown).length).toBe(1);
    expect((module['down'] as () => unknown).length).toBe(1);
  });

  // DSQL runs one DDL statement per transaction, and each execute() is its own.
  test.each(migrations.map((m) => [m.name, m] as const))(
    '%s sends exactly one statement per execute()',
    async (_, migration) => {
      const db = new FakeDb();
      await migration.up(db);
      await migration.down(db);

      for (const statement of db.migrationStatements) {
        expect(statement.replace(/;\s*$/, ''), statement).not.toContain(';');
      }
    },
  );
});

describe('initial schema', () => {
  const upAll = async () => {
    const db = new FakeDb();
    await new MigrationRunner(db, migrations).run();
    return db;
  };

  test('creates exchanges and exchange_attributes idempotently', async () => {
    const { migrationStatements } = await upAll();

    expect(migrationStatements).toContainEqual(
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS exchanges \( id UUID PRIMARY KEY/),
    );
    expect(migrationStatements).toContainEqual(
      expect.stringMatching(
        /^CREATE TABLE IF NOT EXISTS exchange_attributes .*exchange_id UUID NOT NULL REFERENCES exchanges \(id\)/,
      ),
    );
  });

  test('down for every migration undoes the schema in reverse order', async () => {
    const db = await upAll();
    const before = db.migrationStatements.length;

    await new MigrationRunner(db, migrations).run({ action: 'down', steps: migrations.length });

    const downStatements = db.migrationStatements.slice(before);
    const dropAttributes = downStatements.indexOf('DROP TABLE IF EXISTS exchange_attributes');
    const dropExchanges = downStatements.indexOf('DROP TABLE IF EXISTS exchanges');
    expect(dropAttributes).toBeGreaterThanOrEqual(0);
    expect(dropExchanges).toBeGreaterThan(dropAttributes);
    expect([...db.tracking.values()].every((status) => status === 'reverted')).toBe(true);
  });
});

describe('database roles migration', () => {
  test('creates both roles and maps them to their IAM roles', async () => {
    const db = new FakeDb();
    await createDatabaseRoles.up(db);
    const statements = db.migrationStatements;

    expect(statements).toContain('CREATE ROLE "readonly_role" WITH LOGIN');
    expect(statements).toContain('CREATE ROLE "readwrite_role" WITH LOGIN');
    expect(statements).toContain(`AWS IAM GRANT "readonly_role" TO '${READ_ONLY_ROLE_ARN}'`);
    expect(statements).toContain(`AWS IAM GRANT "readwrite_role" TO '${READ_WRITE_ROLE_ARN}'`);
    expect(statements).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO "readonly_role"');
    expect(statements).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "readwrite_role"',
    );
    expect(statements.some((s) => /readonly_role.*(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
  });

  test('skips roles and IAM mappings that already exist, so re-runs are safe', async () => {
    const db = new FakeDb((text) =>
      text.includes('pg_roles') || text.includes('iam_pg_role_mappings') ? [{ '?column?': 1 }] : [],
    );
    await createDatabaseRoles.up(db);

    expect(db.migrationStatements.some((s) => s.startsWith('CREATE ROLE'))).toBe(false);
    expect(db.migrationStatements.some((s) => s.startsWith('AWS IAM GRANT'))).toBe(false);
  });

  test('down revokes everything before dropping the roles', async () => {
    const db = new FakeDb((text) =>
      text.includes('pg_roles') || text.includes('iam_pg_role_mappings') ? [{ '?column?': 1 }] : [],
    );
    await createDatabaseRoles.down(db);
    const statements = db.migrationStatements.filter((s) => !s.startsWith('SELECT'));

    expect(statements.slice(0, 5)).toEqual([
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM "readwrite_role"',
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "readwrite_role"',
      'REVOKE USAGE ON SCHEMA public FROM "readwrite_role"',
      `AWS IAM REVOKE "readwrite_role" FROM '${READ_WRITE_ROLE_ARN}'`,
      'DROP ROLE IF EXISTS "readwrite_role"',
    ]);
  });

  test.each([
    ['missing', undefined],
    ['not an IAM role ARN', 'arn:aws:iam::123456789012:user/someone'],
    ['a SQL injection attempt', "arn:aws:iam::123456789012:role/x'; DROP TABLE exchanges; --"],
  ])('refuses a role ARN that is %s', async (_, arn) => {
    if (arn === undefined) {
      delete process.env['READ_ONLY_ROLE_ARN'];
    } else {
      process.env['READ_ONLY_ROLE_ARN'] = arn;
    }

    await expect(createDatabaseRoles.up(new FakeDb())).rejects.toThrow(
      /READ_ONLY_ROLE_ARN must be set to an IAM role ARN/,
    );
  });
});
