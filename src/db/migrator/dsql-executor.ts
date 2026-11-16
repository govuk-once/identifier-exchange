import { withRetry } from '@aws/aurora-dsql-drizzle';
import { sql, type SQL } from 'drizzle-orm';
import type { MigrationDb, QueryResult } from './types.js';

/**
 * Wraps a drizzle database so each statement:
 *  - is retried on DSQL optimistic-concurrency conflicts (OC000/OC001), and
 *  - waits for its background job when it is asynchronous DDL such as
 *    `CREATE INDEX ASYNC`, which returns a `job_id` immediately.
 */
export const dsqlExecutor = (db: {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}): MigrationDb => {
  const run = async (query: SQL): Promise<QueryResult> => {
    const result = await withRetry(() => db.execute(query));
    return { rows: result.rows as Record<string, unknown>[] };
  };

  return {
    async execute(query) {
      const result = await run(query);
      const jobId = result.rows[0]?.['job_id'];
      if (typeof jobId === 'string' && jobId.length > 0) {
        const wait = await run(sql`CALL sys.wait_for_job(${jobId})`);
        if (wait.rows[0]?.['succeeded'] !== true) {
          throw new Error(`Aurora DSQL async job ${jobId} did not succeed`);
        }
      }
      return result;
    },
  };
};
