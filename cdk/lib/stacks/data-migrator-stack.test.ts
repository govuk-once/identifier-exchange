import * as cdk from 'aws-cdk-lib';
import { describe, expect, test } from 'vitest';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataMigratorStack } from './data-migrator-stack';
import { ContextHelper } from '../utils/context-helper';
import { GovUkOnceEnvironments } from '../constants/environment';
import { TEST_ENV, sharedSubnetIds, sharedVpcId, ssmRef } from '../testing/helpers';

const synth = (developerId?: string) => {
  // Skip esbuild bundling: these tests assert on the template, not the bundle.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  ContextHelper.setAll(app, {
    environment: GovUkOnceEnvironments.Dev,
    appName: 'identifier-exchange',
    developerId,
  });
  const stack = new DataMigratorStack(app, 'TestDataMigratorStack', { env: TEST_ENV });
  return { app, stack, template: Template.fromStack(stack) };
};

const CLUSTER_ARN = '/dev-identifier-exchange/dsql/cluster-arn';
const CLUSTER_ENDPOINT = '/dev-identifier-exchange/dsql/cluster-endpoint';
const CLIENT_SG = '/dev-identifier-exchange/dsql/client-security-group-id';
const DSQL_KEY = '/dev-identifier-exchange/kms/dsql-encryption-key-arn';

/** DSQL refuses connections unless the principal can decrypt with the cluster's key. */
const decryptDsqlKey = (template: Template) => ({
  Action: 'kms:Decrypt',
  Effect: 'Allow',
  Resource: ssmRef(template, DSQL_KEY),
});

const migratorFunction = (template: Template) => {
  const functions = template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: 'dev-identifier-exchange-data-migrator' },
  });
  const [id, fn] = Object.entries(functions)[0] ?? [];
  expect(id).toBeDefined();
  return { id: id!, fn: fn! };
};

describe('Data Migrator Stack', () => {
  test('an isolated (PR) deployment names everything with the developer ID', () => {
    const { template } = synth('pr-123');

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'pr-123-data-migrator',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/pr-123-data-migrator',
    });
    for (const roleName of ['pr-123-dsql-readonly', 'pr-123-dsql-readwrite']) {
      template.hasResourceProperties('AWS::IAM::Role', { RoleName: roleName });
    }
    // Its own DataStack's outputs, but the environment's shared VPC and key.
    ssmRef(template, '/pr-123/dsql/cluster-arn');
    ssmRef(template, '/dev-identifier-exchange/kms/dsql-encryption-key-arn');
    sharedVpcId(template);
  });

  test('reads DataStack and NetworkSecurityStack outputs from SSM, not lookups or exports', () => {
    const { app, template } = synth();

    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    for (const name of [CLUSTER_ARN, CLUSTER_ENDPOINT, CLIENT_SG]) {
      ssmRef(template, name);
    }
    sharedVpcId(template);
    // Synthesizes without asking the CDK CLI to look anything up in the account.
    expect(app.synth().manifest.missing ?? []).toEqual([]);
  });

  test('runs the migrator in the isolated subnets with the DSQL client security group', () => {
    const { template } = synth();
    const { fn } = migratorFunction(template);

    expect(fn.Properties).toMatchObject({
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
      Timeout: 600,
      ReservedConcurrentExecutions: 1,
      VpcConfig: {
        SecurityGroupIds: [ssmRef(template, CLIENT_SG)],
        SubnetIds: sharedSubnetIds(template),
      },
    });
  });

  test('passes the cluster endpoint and workload role ARNs to the migrator', () => {
    const { template } = synth();
    const { fn } = migratorFunction(template);

    expect(fn.Properties.Environment.Variables).toEqual({
      CLUSTER_ENDPOINT: ssmRef(template, CLUSTER_ENDPOINT),
      READ_ONLY_ROLE_ARN: { 'Fn::GetAtt': [expect.stringMatching(/^ReadOnlyDbRole/), 'Arn'] },
      READ_WRITE_ROLE_ARN: { 'Fn::GetAtt': [expect.stringMatching(/^ReadWriteDbRole/), 'Arn'] },
      NODE_OPTIONS: '--enable-source-maps',
    });
  });

  test('migrator can connect as admin to this cluster only, and decrypt with its key', () => {
    const { template } = synth();
    const { fn } = migratorFunction(template);
    const roleId = fn.Properties.Role['Fn::GetAtt'][0] as string;

    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: roleId }],
      PolicyDocument: {
        Statement: [
          {
            Action: 'dsql:DbConnectAdmin',
            Effect: 'Allow',
            Resource: ssmRef(template, CLUSTER_ARN),
          },
          decryptDsqlKey(template),
        ],
      },
    });
  });

  test.each([
    ['ReadOnlyDbRole', 'dev-identifier-exchange-dsql-readonly'],
    ['ReadWriteDbRole', 'dev-identifier-exchange-dsql-readwrite'],
  ])(
    '%s can connect and decrypt with the cluster key, but not as admin',
    (logicalPrefix, roleName) => {
      const { template } = synth();

      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: roleName,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' } }),
            Match.objectLike({ Principal: { Service: 'ecs-tasks.amazonaws.com' } }),
          ],
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        Roles: [{ Ref: Match.stringLikeRegexp(`^${logicalPrefix}`) }],
        PolicyDocument: {
          Statement: [
            { Action: 'dsql:DbConnect', Effect: 'Allow', Resource: ssmRef(template, CLUSTER_ARN) },
            decryptDsqlKey(template),
          ],
        },
      });
    },
  );

  test('runs migrations on deploy whenever the migrator version changes', () => {
    const { template } = synth();

    const [trigger] = Object.values(template.findResources('Custom::Trigger'));
    expect(trigger?.Properties).toMatchObject({
      HandlerArn: { Ref: expect.stringMatching(/^MigratorCurrentVersion/) },
      InvocationType: 'RequestResponse',
      Timeout: '600000',
    });
    expect(trigger?.DependsOn).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ReadOnlyDbRole/),
        expect.stringMatching(/^ReadWriteDbRole/),
      ]),
    );
  });

  test('exposes the migrator for on-demand invocation', () => {
    const { template } = synth();
    const { id } = migratorFunction(template);

    template.hasOutput('MigratorFunctionArn', { Value: { 'Fn::GetAtt': [id, 'Arn'] } });
    template.hasOutput('MigratorFunctionName', { Value: { Ref: id } });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dev-identifier-exchange/data-migrator/function-name',
      Value: { Ref: id },
    });
  });

  test('publishes workload role ARNs for application stacks', () => {
    const { template } = synth();

    for (const [name, prefix] of [
      ['/dev-identifier-exchange/dsql/read-only-role-arn', 'ReadOnlyDbRole'],
      ['/dev-identifier-exchange/dsql/read-write-role-arn', 'ReadWriteDbRole'],
    ] as const) {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: name,
        Value: { 'Fn::GetAtt': [Match.stringLikeRegexp(`^${prefix}`), 'Arn'] },
      });
    }
  });
});
