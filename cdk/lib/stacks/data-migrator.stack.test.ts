import * as cdk from 'aws-cdk-lib';
import { describe, expect, test } from 'vitest';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataMigratorStack } from './data-migrator-stack';
import { ContextHelper } from '../utils/context-helper';
import { GovUkOnceEnvironments } from '../constants/environment';

const synth = () => {
  // Skip esbuild bundling: these tests assert on the template, not the bundle.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  ContextHelper.setAll(app, {
    environment: GovUkOnceEnvironments.Dev,
    appName: 'identifier-exchange',
  });
  const stack = new DataMigratorStack(app, 'TestDataMigratorStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
  });
  return { app, stack, template: Template.fromStack(stack) };
};

/** Ref to the CloudFormation parameter that reads an SSM parameter. */
const ssmRef = (template: Template, parameterName: string) => {
  const [id] = Object.keys(
    template.findParameters('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: parameterName,
    }),
  );
  expect(id, `no SSM lookup for ${parameterName}`).toBeDefined();
  return { Ref: id };
};

const CLUSTER_ARN = '/dev-identifier-exchange/dsql/cluster-arn';
const CLUSTER_ENDPOINT = '/dev-identifier-exchange/dsql/cluster-endpoint';
const CLIENT_SG = '/dev-identifier-exchange/dsql/client-security-group-id';

const migratorFunction = (template: Template) => {
  const functions = template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: 'dev-identifier-exchange-data-migrator' },
  });
  const [id, fn] = Object.entries(functions)[0] ?? [];
  expect(id).toBeDefined();
  return { id: id!, fn: fn! };
};

describe('Data Migrator Stack', () => {
  test('references DataStack and VpcStack by lookup, not cross-stack exports', () => {
    const { app, template } = synth();

    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    for (const name of [CLUSTER_ARN, CLUSTER_ENDPOINT, CLIENT_SG]) {
      ssmRef(template, name);
    }
    const missing = app.synth().manifest.missing ?? [];
    expect(missing).toContainEqual(
      expect.objectContaining({
        provider: 'vpc-provider',
        props: expect.objectContaining({ filter: { 'tag:Name': 'dev-identifier-exchange-vpc' } }),
      }),
    );
  });

  test('runs the migrator in the VPC with the DSQL client security group', () => {
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
        SubnetIds: expect.arrayContaining([expect.stringMatching(/^p-/)]),
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

  test('migrator can connect as admin to this cluster only', () => {
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
        ],
      },
    });
  });

  test.each([
    ['ReadOnlyDbRole', 'dev-identifier-exchange-dsql-readonly'],
    ['ReadWriteDbRole', 'dev-identifier-exchange-dsql-readwrite'],
  ])('%s can connect, but not as admin', (logicalPrefix, roleName) => {
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
        ],
      },
    });
  });

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
