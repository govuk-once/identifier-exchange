import * as cdk from 'aws-cdk-lib';
import { ContextHelper } from '../lib/util/contextHelper';
import { VpcStack } from '../lib/stacks/vpc.stack';
import { DataStack } from '../lib/stacks/data.stack';
import { ExchangeApiStack } from '../lib/stacks/exchange-api.stack';
import { GovUkOnceEnvironments } from '../lib/constants/environment';
const app = new cdk.App();
ContextHelper.setAll(app, {
  environment: (process.env.ENV as GovUkOnceEnvironments) || GovUkOnceEnvironments.Dev,
  appName: 'identifier-exchange',
});
new VpcStack(app, 'VpcStack');
new DataStack(app, 'DataStack');
new ExchangeApiStack(app, 'ExchangeApiStack');
