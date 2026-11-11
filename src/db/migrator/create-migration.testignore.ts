import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  MIGRATIONS_DIR,
  createMigration,
  listMigrations,
  newMigrationName,
  renderIndex,
  toSnakeCase,
} from './create-migration.js';

const NOW = new Date(Date.UTC(2026, 10, 11, 9, 30, 5));

describe('newMigrationName', () => {
  test('prefixes a snake_case description with the UTC timestamp', () => {
    expect(newMigrationName('Add exchange status!', [], NOW)).toBe(
      '20261111093005_add_exchange_status',
    );
  });

  test.each([
    ['add-exchange status', 'add_exchange_status'],
    ['  Drop   OLD_table  ', 'drop_old_table'],
    ['v2 index', 'v2_index'],
  ])('%j becomes %j', (description, slug) => {
    expect(toSnakeCase(description)).toBe(slug);
  });

  test('refuses an empty description', () => {
    expect(() => newMigrationName(' !! ', [], NOW)).toThrow(/Describe the migration/);
  });

  test('always sorts after the newest existing migration', () => {
    expect(newMigrationName('next', ['20261111093005_same_second'], NOW)).toBe(
      '20261111093006_next',
    );
    expect(newMigrationName('next', ['20991231235959_from_the_future'], NOW)).toBe(
      '21000101000000_next',
    );
  });
});

describe('renderIndex', () => {
  test('reproduces the committed index.ts', () => {
    const committed = readFileSync(path.join(MIGRATIONS_DIR, 'index.ts'), 'utf8');

    expect(renderIndex(listMigrations())).toBe(committed);
  });

  test('gives clashing descriptions distinct import names', () => {
    const index = renderIndex(['20260101000001_add_index', '20260101000002_add_index']);

    expect(index).toContain("import * as addIndex from './20260101000001_add_index.js';");
    expect(index).toContain(
      "import * as migration20260101000002 from './20260101000002_add_index.js';",
    );
  });
});

describe('createMigration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'migrations-'));
    writeFileSync(path.join(dir, '20261106000001_create_exchanges.ts'), '');
    writeFileSync(path.join(dir, 'index.ts'), '');
    writeFileSync(path.join(dir, 'migrations.test.ts'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('writes a stub migration and registers it in index.ts', () => {
    const file = createMigration('add exchange status', dir, NOW);

    expect(path.basename(file)).toBe('20261111093005_add_exchange_status.ts');
    expect(readFileSync(file, 'utf8')).toMatch(/export async function up\(_db: MigrationDb\)/);
    expect(readFileSync(path.join(dir, 'index.ts'), 'utf8')).toBe(
      renderIndex(['20261106000001_create_exchanges', '20261111093005_add_exchange_status']),
    );
  });

  test('never overwrites an existing file', () => {
    createMigration('add exchange status', dir, NOW);
    writeFileSync(path.join(dir, '20261111093006_add_exchange_status.ts'), 'keep me');

    // Same second again: the name is bumped past the newest file, not reused.
    const file = createMigration('add exchange status', dir, NOW);

    expect(path.basename(file)).toBe('20261111093007_add_exchange_status.ts');
    expect(readdirSync(dir)).toHaveLength(6);
  });
});
