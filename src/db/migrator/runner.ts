// cspell:words TIMESTAMPTZ
import { sql } from 'drizzle-orm';
import type {
  Migration,
  MigrationDb,
  MigrationReport,
  MigrationRequest,
  MigrationStatus,
} from './types.js';

export const TRACKING_TABLE = 'schema_migrations';

interface TrackingRow {
  name: string;
  status: MigrationStatus;
}

/**
 * Applies and reverts TypeScript migrations, recording each one in
 * `schema_migrations` (name, status, executed_at, error).
 *
 * DSQL commits every DDL statement on its own, so a migration is not atomic:
 * a failure part-way leaves earlier statements applied and the row marked
 * `failed`. The next `up` re-runs the whole migration, which is why
 * migrations must be idempotent (`IF NOT EXISTS` / `IF EXISTS`).
 *
 * Ordering is strict so that runs are deterministic: migrations apply in
 * name order, and the runner refuses to continue if the database has a
 * migration the code does not know about, or if a pending migration sorts
 * before one that is already applied.
 */
export class MigrationRunner {
  private readonly migrations: readonly Migration[];

  constructor(
    private readonly db: MigrationDb,
    migrations: readonly Migration[],
    private readonly log: (message: string) => void = () => {},
  ) {
    const names = migrations.map((m) => m.name);
    const sorted = [...names].toSorted();
    if (names.some((name, i) => name !== sorted[i]) || new Set(names).size !== names.length) {
      throw new Error('Migrations must be unique and listed in name order');
    }
    this.migrations = migrations;
  }

  async run(request: MigrationRequest = {}): Promise<MigrationReport> {
    const action = request.action ?? 'up';
    if (!['up', 'down', 'status'].includes(action)) {
      throw new Error(`Unknown action "${action}". Use "up", "down" or "status".`);
    }
    await this.ensureTrackingTable();

    let ran: string[] = [];
    if (action === 'up') {
      ran = await this.up();
    } else if (action === 'down') {
      ran = await this.down('steps' in request ? (request.steps ?? 1) : 1);
    }

    const { applied, pending } = await this.status();
    return { action, ran, applied, pending };
  }

  async status(): Promise<{ applied: string[]; pending: string[] }> {
    const rows = await this.readTracking();
    const applied = new Set(rows.filter((r) => r.status === 'applied').map((r) => r.name));

    const unknown = [...applied].filter((name) => !this.migrations.some((m) => m.name === name));
    if (unknown.length > 0) {
      throw new Error(
        `Database has applied migrations this code does not include: ${unknown.join(', ')}`,
      );
    }

    return {
      applied: this.migrations.filter((m) => applied.has(m.name)).map((m) => m.name),
      pending: this.migrations.filter((m) => !applied.has(m.name)).map((m) => m.name),
    };
  }

  private async up(): Promise<string[]> {
    const { applied, pending } = await this.status();
    const lastApplied = applied.at(-1);
    const outOfOrder = lastApplied ? pending.filter((name) => name < lastApplied) : [];
    if (outOfOrder.length > 0) {
      throw new Error(
        `Pending migrations sort before already-applied ${lastApplied}: ${outOfOrder.join(', ')}. ` +
          'Rename them with a later timestamp.',
      );
    }

    const ran: string[] = [];
    for (const migration of this.migrations.filter((m) => pending.includes(m.name))) {
      await this.apply(migration, 'up');
      ran.push(migration.name);
    }
    return ran;
  }

  private async down(steps: number): Promise<string[]> {
    if (!Number.isInteger(steps) || steps < 1) {
      throw new Error(`steps must be a positive integer, got ${steps}`);
    }
    const { applied } = await this.status();
    const toRevert = applied.slice(-steps).toReversed();

    for (const name of toRevert) {
      const migration = this.migrations.find((m) => m.name === name);
      if (migration) {
        await this.apply(migration, 'down');
      }
    }
    return toRevert;
  }

  private async apply(migration: Migration, direction: 'up' | 'down'): Promise<void> {
    this.log(`${direction === 'up' ? 'Applying' : 'Reverting'} ${migration.name}`);
    await this.record(migration.name, 'running');
    try {
      await migration[direction](this.db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(migration.name, 'failed', message);
      throw new Error(`Migration ${migration.name} (${direction}) failed: ${message}`, {
        cause: error,
      });
    }
    await this.record(migration.name, direction === 'up' ? 'applied' : 'reverted');
  }

  private async ensureTrackingTable(): Promise<void> {
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${sql.identifier(TRACKING_TABLE)} (
        name VARCHAR(255) PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        error TEXT
      )
    `);
  }

  private async readTracking(): Promise<TrackingRow[]> {
    const { rows } = await this.db.execute(
      sql`SELECT name, status FROM ${sql.identifier(TRACKING_TABLE)} ORDER BY name`,
    );
    return rows as unknown as TrackingRow[];
  }

  private async record(name: string, status: MigrationStatus, error?: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO ${sql.identifier(TRACKING_TABLE)} (name, status, executed_at, error)
      VALUES (${name}, ${status}, NOW(), ${error ?? null})
      ON CONFLICT (name) DO UPDATE
        SET status = EXCLUDED.status, executed_at = EXCLUDED.executed_at, error = EXCLUDED.error
    `);
  }
}
