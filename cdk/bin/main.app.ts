import * as cdk from 'aws-cdk-lib';
import { ContextHelper } from '../lib/utils/context-helper';
import { NetworkSecurityStack } from '../lib/stacks/network-security.stack';
import { DataStack } from '../lib/stacks/data.stack';
// import { ExchangeApiStack } from '../lib/stacks/exchange-api.stack';
import { GovUkOnceEnvironments } from '../lib/constants/environment';
import { DataMigratorStack } from '../lib/stacks/data-migrator-stack';

/**
 * `pr-123` for a pull request, unset for the shared environment deployment.
 *
 * DEVELOPER_ID wins if set (same convention as user-data-platform, and handy
 * for a personal stack locally). Otherwise, inside GitHub Actions, it comes
 * from the PR number: GITHUB_REF is `refs/pull/<n>/merge` for every
 * pull_request event (deploy on open/sync, cleanup on close), including in
 * jobs of the shared reusable workflow, which doesn't receive our `env:`.
 */
const prNumber =
  process.env.GITHUB_EVENT_NAME?.startsWith('pull_request') &&
  /^refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '')?.[1];
const developerId = process.env.DEVELOPER_ID || (prNumber ? `pr-${prNumber}` : undefined);
const environment = (process.env.ENV as GovUkOnceEnvironments) || GovUkOnceEnvironments.Dev;

const app = new cdk.App();
ContextHelper.setAll(app, {
  environment,
  appName: 'identifier-exchange',
  developerId,
});

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.AWS_DEFAULT_REGION,
};

/**
 * Isolated deployments get `pr-123-<name>` stack names so PRs don't collide.
 * The shared deployment keeps its existing stack names (renaming a deployed
 * stack would replace everything in it).
 */
const stackProps = (name: string): cdk.StackProps => ({
  env,
  ...(developerId && { stackName: `${developerId}-${name}` }),
});

// The network stack is shared by every deployment in the environment, so an
// isolated deployment neither deploys nor (on PR cleanup) destroys it; it
// reads the shared VPC and keys from SSM instead.
const network = new NetworkSecurityStack(app, 'NetworkSecurityStack', {
  env,
  stackName: `${environment}-network-security-stack`,
});
const data = new DataStack(app, 'DataStack', stackProps('data-stack'));
const migrator = new DataMigratorStack(app, 'DataMigratorStack', stackProps('data-migrator-stack'));

data.addStackDependency(network);
migrator.addStackDependency(data);

// new ExchangeApiStack(app, 'ExchangeApiStack', stackProps('exchange-api-stack'));
