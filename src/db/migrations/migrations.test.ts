import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { FakeDb } from '../migrator/testing.js';
import { migrations } from './index.js';

const FILE_NAME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$/;

const migrationFiles = readdirSync(import.meta.dirname).filter(
  (file) => file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts'),
);

// Per-file checks use plain loops rather than test.each, so they simply
// register no tests while the migrations list is empty.
describe('migration files', () => {
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
  }
});
