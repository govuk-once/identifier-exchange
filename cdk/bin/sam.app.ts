import { App, Aspects } from 'aws-cdk-lib';
import { GDSEnv } from '@govuk-connect/dev';

import { ContextHelper } from '../lib/utils/context-helper.js';
import { MainStack as DsqlStack } from '../lib/stacks/dsql.stack.ts';
import { MainStack as DynamoStack } from '../lib/stacks/dynamo.stack.ts';
import { MainStack as QueueStack } from '../lib/stacks/queue.stack.ts';

const app = new App();

ContextHelper.setAll(app, {
  environment: GDSEnv.get() || GDSEnv.DEVELOPMENT,
  account: process.env['CDK_DEFAULT_ACCOUNT'] || '123456789012',
  region: process.env['CDK_DEFAULT_REGION'] || 'eu-west-2',
});

new DsqlStack(app, 'ConnectFooMainDsqlStack');

new DynamoStack(app, 'ConnectFooMainDynamoStack');

new QueueStack(app, 'ConnectFooMainQueueStack');

if (process.env['SAM_LOCAL'] === 'true') {
  const { SAMLocalAspect } = await import('@govuk-connect/dev/sam');
  Aspects.of(app).add(new SAMLocalAspect(app));
}
