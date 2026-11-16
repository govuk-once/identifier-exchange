import { describe, expect, test } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { dsqlExecutor } from './dsql-executor.js';
import { render } from './testing.js';

const fakeDrizzle = (respond: (text: string) => unknown[]) => {
  const seen: string[] = [];
  return {
    seen,
    db: {
      async execute(query: SQL) {
        const { sql: text } = render(query);
        seen.push(text);
        return { rows: respond(text) };
      },
    },
  };
};

describe('dsqlExecutor', () => {
  test('passes ordinary statements straight through', async () => {
    const { db, seen } = fakeDrizzle(() => [{ id: 1 }]);

    const result = await dsqlExecutor(db).execute(sql`SELECT 1`);

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(seen).toEqual(['SELECT 1']);
  });

  test('waits for the background job of asynchronous DDL', async () => {
    const { db, seen } = fakeDrizzle((text) =>
      text.startsWith('CREATE INDEX ASYNC') ? [{ job_id: 'job-123' }] : [{ succeeded: true }],
    );

    await dsqlExecutor(db).execute(sql`CREATE INDEX ASYNC idx ON t (c)`);

    expect(seen).toEqual(['CREATE INDEX ASYNC idx ON t (c)', 'CALL sys.wait_for_job($1)']);
  });

  test('fails when the background job does not succeed', async () => {
    const { db } = fakeDrizzle((text) =>
      text.startsWith('CREATE') ? [{ job_id: 'job-123' }] : [{ succeeded: false }],
    );

    await expect(dsqlExecutor(db).execute(sql`CREATE INDEX ASYNC idx ON t (c)`)).rejects.toThrow(
      'Aurora DSQL async job job-123 did not succeed',
    );
  });
});
