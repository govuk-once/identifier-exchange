import { describe, expect, test } from 'vitest';
import { down, up } from '../migrations/20261126152208_create_identifier_attributes.js';
import { FakeDb } from '../migrator/testing.js';
import { normalise, schemaStatements } from './testing.js';

describe('identifier_attributes schema', () => {
  test('the migration creates exactly what identifier_attributes.sql defines', async () => {
    const db = new FakeDb();
    await up(db);

    const created = db.migrationStatements.filter((s) => s.startsWith('CREATE')).map(normalise);
    expect(created).toEqual(schemaStatements('identifier_attributes.sql'));
  });

  test('up() grants the application roles access to the table', async () => {
    const db = new FakeDb();
    await up(db);

    expect(db.migrationStatements.filter((s) => s.startsWith('GRANT'))).toEqual([
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "identifier_attributes" TO "readwrite_role"',
      'GRANT SELECT ON "identifier_attributes" TO "readonly_role"',
    ]);
  });

  test('down() drops the indexes, then the table', async () => {
    const db = new FakeDb();
    await down(db);

    expect(db.migrationStatements).toEqual([
      'DROP INDEX IF EXISTS "idx_identifier_attributes_linked_identifier_id"',
      'DROP INDEX IF EXISTS "idx_identifier_attributes_linked_id_name"',
      'DROP TABLE IF EXISTS "identifier_attributes"',
    ]);
  });
});
