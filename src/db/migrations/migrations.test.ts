import { readdirSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeDb } from '../migrator/testing.js';
import { migrations } from './index.js';

const FILE_NAME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$/;

const migrationFiles = readdirSync(import.meta.dirname).filter(
  (file) => file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts'),
);

// What DataMigratorStack sets on the migrator Lambda.
const MIGRATOR_ENV = {
  READ_WRITE_ROLE_ARN: 'arn:aws:iam::123456789012:role/dev-identifier-exchange-dsql-readwrite',
  READ_ONLY_ROLE_ARN: 'arn:aws:iam::123456789012:role/dev-identifier-exchange-dsql-readonly',
};

/**
 * DSQL rejects identity columns and sequences without CACHE 1 or >= 65536.
 * Matches a CACHE clause and captures its value.
 */
const IDENTITY_OR_SEQUENCE = /\bAS IDENTITY\b|\bCREATE SEQUENCE\b/i;
const CACHE = /\bCACHE\s+(\d+)/i;

/** Only DML can take bind parameters; Postgres rejects $n anywhere in DDL. */
const DML = /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i;

// Per-file checks use plain loops rather than test.each, so they simply
// register no tests while the migrations list is empty.
describe('migration files', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(MIGRATOR_ENV)) vi.stubEnv(name, value);
    return () => vi.unstubAllEnvs();
  });

  test('index.ts lists every migration file, in order', () => {
    expect(migrations.map((m) => `${m.name}.ts`)).toEqual(migrationFiles.toSorted());
  });

  for (const file of migrationFiles) {
    test(`${file} is named <UTC yyyyMMddHHmmss>_<snake_case>.ts`, () => {
      const match = FILE_NAME.exec(file);
      expect(match, `${file} does not match ${FILE_NAME}`).not.toBeNull();

      const [y = 0, mo = 0, d, h, mi, s] = (match ?? []).slice(1).map(Number);
      const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
      // Round-tripping catches impossible dates such as month 13 or hour 25.
      expect(date.getUTCMonth() + 1).toBe(mo);
      expect(date.getUTCDate()).toBe(d);
      expect(date.getUTCHours()).toBe(h);
    });

    test(`${file} exports up(db) and down(db)`, async () => {
      const module = (await import(`./${file}`)) as Record<string, unknown>;

      expect(module['up']).toBeTypeOf('function');
      expect(module['down']).toBeTypeOf('function');
      expect((module['up'] as () => unknown).length).toBe(1);
      expect((module['down'] as () => unknown).length).toBe(1);
    });
  }

  // DSQL runs one DDL statement per transaction, and each execute() is its own.
  for (const migration of migrations) {
    test(`${migration.name} sends exactly one statement per execute()`, async () => {
      const db = new FakeDb();
      await migration.up(db);
      await migration.down(db);

      for (const statement of db.migrationStatements) {
        expect(statement.replace(/;\s*$/, ''), statement).not.toContain(';');
      }
    });

    test(`${migration.name} gives identity columns and sequences a DSQL-supported CACHE`, async () => {
      const db = new FakeDb();
      await migration.up(db);

      for (const statement of db.migrationStatements.filter((s) => IDENTITY_OR_SEQUENCE.test(s))) {
        const cache = Number(CACHE.exec(statement)?.[1]);
        expect(cache === 1 || cache >= 65536, `needs CACHE 1 or >= 65536: ${statement}`).toBe(true);
      }
    });

    test(`${migration.name} passes no bind parameters to DDL`, async () => {
      const db = new FakeDb();
      await migration.up(db);
      await migration.down(db);

      for (const { sql, params } of db.statements) {
        if (!DML.test(sql)) expect(params, sql).toEqual([]);
      }
    });
  }
});
