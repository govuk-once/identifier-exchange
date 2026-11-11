// Explicit `.ts` extensions on relative imports are required for SAM local synthesis
// so `ts-node` (via `--prefer-ts-exts` / ESM loaders) can resolve relative TypeScript module
// paths directly without requiring a pre-compilation step.

import { App, Aspects } from 'aws-cdk-lib';
import { GDSEnv } from '@govuk-connect/dev';

// @ts-ignore
import { ContextHelper } from '../lib/utils/context-helper.ts';
// @ts-ignore
import { SAMDSQLStack } from '../lib/stacks/sam/sam-dsql.stack.ts';
// @ts-ignore
import { SAMDynamoDBStack } from '../lib/stacks/sam/sam-dynamo-db.stack.ts';
// @ts-ignore
import { SAMQueueStack } from '../lib/stacks/sam/sam-queue.stack.ts';

const app = new App();

ContextHelper.setAll(app, {
  environment: GDSEnv.DEVELOPMENT,
});

new SAMDSQLStack(app, 'SAMDsqlStack');

new SAMDynamoDBStack(app, 'SAMDynamoStack');

new SAMQueueStack(app, 'SAMQueueStack');

if (process.env['SAM_LOCAL'] === 'true') {
  const { SAMLocalAspect } = await import('@govuk-connect/dev/sam');
  Aspects.of(app).add(new SAMLocalAspect(app));
}
