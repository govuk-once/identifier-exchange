import { describe, expect, test } from 'vitest';
import { FakeDb } from '../migrator/testing.js';
import { down, up } from './20261127141418_grant_delete_role_row_lock.js';

describe('20261127141418_grant_delete_role_row_lock', () => {
  test('up() lets delete_role lock linked_identifiers rows', async () => {
    const fake = new FakeDb();
    await up(fake);

    expect(fake.migrationStatements).toEqual([
      'GRANT UPDATE ON "linked_identifiers" TO "delete_role"',
    ]);
  });

  test('down() takes the privilege back', async () => {
    const fake = new FakeDb();
    await down(fake);

    expect(fake.migrationStatements).toEqual([
      'REVOKE UPDATE ON "linked_identifiers" FROM "delete_role"',
    ]);
  });
});
