import { App } from 'aws-cdk-lib';
import { GDSEnv } from '@govuk-connect/dev';

import { ContextHelper } from '../lib/utils/context-helper.js';
import { VpcStack } from '../lib/stacks/vpc.stack.js';
import { DataStack } from '../lib/stacks/data.stack.js';
import { ExchangeApiStack } from '../lib/stacks/exchange-api.stack.js';

const app = new App();

ContextHelper.setAll(app, {
  environment: GDSEnv.get() || GDSEnv.DEVELOPMENT,
});

new VpcStack(app, 'VpcStack');
new DataStack(app, 'DataStack');
new ExchangeApiStack(app, 'ExchangeApiStack');
