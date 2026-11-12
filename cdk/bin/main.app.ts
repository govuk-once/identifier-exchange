import * as cdk from 'aws-cdk-lib';
import { ContextHelper } from '../lib/utils/context-helper';
import { NetworkSecurityStack } from '../lib/stacks/network-security.stack';
import { DataStack } from '../lib/stacks/data.stack';
// import { ExchangeApiStack } from '../lib/stacks/exchange-api.stack';
import { GovUkOnceEnvironments } from '../lib/constants/environment';
import { DataMigratorStack } from '../lib/stacks/data-migrator-stack';
const app = new cdk.App();
ContextHelper.setAll(app, {
  environment: (process.env.ENV as GovUkOnceEnvironments) || GovUkOnceEnvironments.Dev,
  appName: 'identifier-exchange',
});

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.AWS_DEFAULT_REGION,
};

const network = new NetworkSecurityStack(app, 'VpcStack', { env });
const data = new DataStack(app, 'DataStack', { env });
const migrator = new DataMigratorStack(app, 'DataMigratorStack', { env });

data.addStackDependency(network);
migrator.addStackDependency(data);

// new ExchangeApiStack(app, 'ExchangeApiStack', { env });
