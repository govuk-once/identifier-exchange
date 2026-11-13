import { Logger } from '@aws-lambda-powertools/logger';
import { drizzle } from '@aws/aurora-dsql-drizzle';
import { migrations } from '../migrations/index.js';
import { dsqlExecutor } from './dsql-executor.js';
import { MigrationRunner } from './runner.js';
import type { MigrationReport, MigrationRequest } from './types.js';

const logger = new Logger({ serviceName: 'data-migrator' });

export const handler = async (event: MigrationRequest | null = {}): Promise<MigrationReport> => {
  const host = process.env['CLUSTER_ENDPOINT'];
  if (!host) {
    throw new Error('CLUSTER_ENDPOINT is not set');
  }

  const db = drizzle({ connection: { host, user: 'admin', max: 1 } });
  type DsqlQuery = Parameters<typeof db.execute>[0];
  const executor = dsqlExecutor({
    execute: (query) => db.execute(query as unknown as DsqlQuery),
  });
  try {
    const runner = new MigrationRunner(executor, migrations, (message) => logger.info(message));
    const report = await runner.run(event ?? {});
    logger.info('Migrations finished', { report });
    return report;
  } catch (error) {
    logger.error('Migrations failed', { error });
    throw new Error(describeErrorChain(error), { cause: error });
  } finally {
    await db.$client.end();
  }
};

/**
 * One line per error in the `cause` chain, including the Postgres SQLSTATE
 * and Node error code (e.g. ENOTFOUND, ETIMEDOUT) where present.
 */
export const describeErrorChain = (error: unknown): string => {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current && !seen.has(current);) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      const message = current.message.replace(/\s+/g, ' ').trim();
      lines.push(`${current.name}${code ? ` [${String(code)}]` : ''}: ${message}`);
      // Node reports a failed connect to several addresses as an AggregateError.
      if (current instanceof AggregateError) {
        lines.push(...current.errors.map((e: unknown) => `  - ${String(e)}`));
      }
      current = current.cause;
    } else {
      lines.push(String(current));
      break;
    }
  }
  return lines.map((line, i) => (i === 0 ? line : `caused by ${line}`)).join('\n');
};
