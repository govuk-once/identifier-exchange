import { App, Aspects } from 'aws-cdk-lib';
import { GDSEnv } from '@govuk-connect/dev';

import { ContextHelper } from '../lib/utils/context-helper.js';
import { SAMDSQLStack } from '../lib/stacks/sam/sam-dsql.stack.js';
import { SAMDynamoDBStack } from '../lib/stacks/sam/sam-dynamo-db.stack.js';
import { SAMQueueStack } from '../lib/stacks/sam/sam-queue.stack.js';

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
