import { Logger } from '@aws-lambda-powertools/logger';
import { drizzle } from '@aws/aurora-dsql-drizzle';
import { migrations } from '../migrations/index.js';
import { dsqlExecutor } from './dsql-executor.js';
import { MigrationRunner } from './runner.js';
import type { MigrationReport, MigrationRequest } from './types.js';

const logger = new Logger({ serviceName: 'data-migrator' });

/**
 * Lambda entry point. Invoked with no payload by the deploy-time trigger
 * (applies pending migrations), or on demand:
 *
 *   aws lambda invoke --function-name <name> \
 *     --cli-binary-format raw-in-base64-out \
 *     --payload '{"action":"down","steps":1}' out.json
 *
 * Throws on failure so the invocation (and a deploy-time trigger) fails.
 */
export const handler = async (event: MigrationRequest | null = {}): Promise<MigrationReport> => {
  const host = process.env['CLUSTER_ENDPOINT'];
  if (!host) {
    throw new Error('CLUSTER_ENDPOINT is not set');
  }

  // Connects as `admin`: creating roles and running AWS IAM GRANT needs it.
  // The connector generates a short-lived IAM auth token for each connection.
  const db = drizzle({ connection: { host, user: 'admin', max: 1 } });
  // @aws/aurora-dsql-drizzle is CommonJS, so TypeScript sees its drizzle-orm
  // `SQL` type as distinct from the ESM one used here. They are the same
  // class at runtime (drizzle matches on entityKind, not identity).
  type DsqlQuery = Parameters<typeof db.execute>[0];
  const executor = dsqlExecutor({
    execute: (query) => db.execute(query as unknown as DsqlQuery),
  });
  try {
    const runner = new MigrationRunner(executor, migrations, (message) => logger.info(message));
    const report = await runner.run(event ?? {});
    logger.info('Migrations finished', { report });
    return report;
  } finally {
    await db.$client.end();
  }
};
