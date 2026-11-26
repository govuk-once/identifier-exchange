import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { down, up } from '../migrations/20261126141927_create_linked_identifiers.js';
import { FakeDb } from '../migrator/testing.js';

const SCHEMA_FILE = path.join(import.meta.dirname, 'linked_identifiers.sql');

/** Compares statements ignoring layout and identifier quoting. */
const normalise = (statement: string) =>
  statement
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim();

const schemaStatements = () =>
  readFileSync(SCHEMA_FILE, 'utf8')
    .replace(/--.*$/gm, '')
    .split(';')
    .map(normalise)
    .filter(Boolean);

describe('linked_identifiers schema', () => {
  test('the migration creates exactly what linked_identifiers.sql defines', async () => {
    const db = new FakeDb();
    await up(db);

    const created = db.migrationStatements.filter((s) => s.startsWith('CREATE')).map(normalise);
    expect(created).toEqual(schemaStatements());
  });

  test('up() grants the application roles access to the table', async () => {
    const db = new FakeDb();
    await up(db);

    expect(db.migrationStatements.filter((s) => s.startsWith('GRANT'))).toEqual([
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "linked_identifiers" TO "readwrite_role"',
      'GRANT SELECT ON "linked_identifiers" TO "readonly_role"',
    ]);
  });

  test('down() drops the indexes, then the table', async () => {
    const db = new FakeDb();
    await down(db);

    expect(db.migrationStatements).toEqual([
      'DROP INDEX IF EXISTS "idx_linked_identifiers_idx_id"',
      'DROP INDEX IF EXISTS "idx_linked_identifiers_unique_link"',
      'DROP INDEX IF EXISTS "idx_linked_identifiers_anchor"',
      'DROP TABLE IF EXISTS "linked_identifiers"',
    ]);
  });
});
