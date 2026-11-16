// cspell:words TIMESTAMPTZ
import { describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { MigrationRunner } from './runner.js';
import { FakeDb } from './testing.js';
import type { Migration, MigrationRequest } from './types.js';

const migration = (name: string, opts: { failUp?: () => boolean } = {}): Migration => ({
  name,
  async up(db) {
    if (opts.failUp?.()) {
      throw new Error(`${name} exploded`);
    }
    await db.execute(sql.raw(`-- ${name} up`));
  },
  async down(db) {
    await db.execute(sql.raw(`-- ${name} down`));
  },
});

const A = migration('20260101000001_a');
const B = migration('20260101000002_b');
const C = migration('20260101000003_c');

const setup = (migrations: Migration[] = [A, B, C]) => {
  const db = new FakeDb();
  const run = (request?: MigrationRequest) => new MigrationRunner(db, migrations).run(request);
  return { db, run };
};

describe('MigrationRunner', () => {
  test('up applies every pending migration in name order', async () => {
    const { db, run } = setup();

    const report = await run();

    expect(report).toEqual({
      action: 'up',
      ran: [A.name, B.name, C.name],
      applied: [A.name, B.name, C.name],
      pending: [],
    });
    expect(db.migrationStatements).toEqual([
      `-- ${A.name} up`,
      `-- ${B.name} up`,
      `-- ${C.name} up`,
    ]);
    expect([...db.tracking.values()]).toEqual(['applied', 'applied', 'applied']);
  });

  test('creates the tracking table before reading it', async () => {
    const { db, run } = setup();

    await run({ action: 'status' });

    expect(db.statements[0]?.sql).toMatch(/CREATE TABLE IF NOT EXISTS "schema_migrations"/);
    expect(db.statements[0]?.sql).toMatch(/name VARCHAR\(255\) PRIMARY KEY/);
    expect(db.statements[0]?.sql).toMatch(/status VARCHAR\(16\) NOT NULL/);
    expect(db.statements[0]?.sql).toMatch(/executed_at TIMESTAMPTZ NOT NULL/);
  });

  test('a second up is a no-op', async () => {
    const { db, run } = setup();
    await run();
    const before = db.migrationStatements.length;

    const report = await run();

    expect(report.ran).toEqual([]);
    expect(db.migrationStatements).toHaveLength(before);
  });

  test('down reverts the latest migration by default', async () => {
    const { db, run } = setup();
    await run();

    const report = await run({ action: 'down' });

    expect(report.ran).toEqual([C.name]);
    expect(report.pending).toEqual([C.name]);
    expect(db.tracking.get(C.name)).toBe('reverted');
    expect(db.migrationStatements.at(-1)).toBe(`-- ${C.name} down`);
  });

  test('down with steps reverts newest first, and up re-applies them', async () => {
    const { db, run } = setup();
    await run();

    const down = await run({ action: 'down', steps: 2 });
    expect(down.ran).toEqual([C.name, B.name]);
    expect(db.migrationStatements.slice(-2)).toEqual([`-- ${C.name} down`, `-- ${B.name} down`]);

    const up = await run();
    expect(up.ran).toEqual([B.name, C.name]);
    expect(up.applied).toEqual([A.name, B.name, C.name]);
  });

  test('down with more steps than applied reverts everything', async () => {
    const { run } = setup();
    await run();

    const report = await run({ action: 'down', steps: 10 });

    expect(report.ran).toEqual([C.name, B.name, A.name]);
    expect(report.applied).toEqual([]);
  });

  test('a failure stops the run, is recorded, and is retried by the next up', async () => {
    let failing = true;
    const flaky = migration('20260101000002_b', { failUp: () => failing });
    const { db, run } = setup([A, flaky, C]);

    await expect(run()).rejects.toThrow(
      `Migration ${flaky.name} (up) failed: ${flaky.name} exploded`,
    );
    expect(db.tracking.get(A.name)).toBe('applied');
    expect(db.tracking.get(flaky.name)).toBe('failed');
    expect(db.tracking.has(C.name)).toBe(false);
    const errorRow = db.statements.find((s) => s.params[1] === 'failed');
    expect(errorRow?.params[2]).toBe(`${flaky.name} exploded`);

    failing = false;
    const report = await run();
    expect(report.ran).toEqual([flaky.name, C.name]);
  });

  test('status reports without running anything', async () => {
    const { db, run } = setup();
    await run();
    await run({ action: 'down' });
    const before = db.migrationStatements.length;

    const report = await run({ action: 'status' });

    expect(report).toEqual({
      action: 'status',
      ran: [],
      applied: [A.name, B.name],
      pending: [C.name],
    });
    expect(db.migrationStatements).toHaveLength(before);
  });

  test('refuses to run when the database has migrations the code lacks', async () => {
    const { db, run } = setup([A, B]);
    db.tracking.set('20260101000009_from_newer_code', 'applied');

    await expect(run()).rejects.toThrow(/does not include: 20260101000009_from_newer_code/);
  });

  test('refuses a pending migration that sorts before an applied one', async () => {
    const { db, run } = setup([A, B, C]);
    db.tracking.set(A.name, 'applied');
    db.tracking.set(C.name, 'applied');

    await expect(run()).rejects.toThrow(
      /sort before already-applied 20260101000003_c: 20260101000002_b/,
    );
    expect(db.migrationStatements).toEqual([]);
  });

  test('rejects migrations that are not in name order', () => {
    expect(() => new MigrationRunner(new FakeDb(), [B, A])).toThrow(/name order/);
    expect(() => new MigrationRunner(new FakeDb(), [A, A])).toThrow(/unique/);
  });

  test('rejects unknown actions and invalid steps', async () => {
    const { run } = setup();

    await expect(run({ action: 'sideways' } as unknown as MigrationRequest)).rejects.toThrow(
      /Unknown action "sideways"/,
    );
    await expect(run({ action: 'down', steps: 0 })).rejects.toThrow(/positive integer/);
  });
});
