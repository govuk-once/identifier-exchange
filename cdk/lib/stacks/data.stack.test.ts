import * as cdk from 'aws-cdk-lib';
import { describe, expect, test } from 'vitest';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { DSQL_PORT, DataStack } from './data.stack';
import { ContextHelper } from '../utils/context-helper';
import { GovUkOnceEnvironments } from '../constants/environment';

// With no cached context, Vpc.fromLookup returns CDK's dummy VPC.
const DUMMY_VPC_ID = 'vpc-12345';

const synth = (environment = GovUkOnceEnvironments.Dev) => {
  const app = new cdk.App();
  ContextHelper.setAll(app, { environment, appName: 'identifier-exchange' });
  const dataStack = new DataStack(app, 'TestDataStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
  });
  return { app, dataStack, template: Template.fromStack(dataStack) };
};

/** The CloudFormation parameter that resolves the key ARN from SSM. */
const keyArnParameter = (template: Template) => {
  const params = template.findParameters('*', {
    Type: 'AWS::SSM::Parameter::Value<String>',
    Default: '/dev-identifier-exchange/kms/encryption-key-arn',
  });
  const [id] = Object.keys(params);
  expect(id).toBeDefined();
  return id as string;
};

describe('Data Stack', () => {
  test('creates one DSQL cluster encrypted with the shared KMS key', () => {
    const { template } = synth();

    template.resourceCountIs('AWS::DSQL::Cluster', 1);
    template.hasResourceProperties('AWS::DSQL::Cluster', {
      KmsEncryptionKey: { Ref: keyArnParameter(template) },
    });
  });

  test('references shared resources by lookup, not cross-stack exports', () => {
    const { app, template } = synth();

    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    // The VPC lookup is requested from the CDK CLI as missing context.
    const missing = app.synth().manifest.missing ?? [];
    expect(missing).toContainEqual(
      expect.objectContaining({
        provider: 'vpc-provider',
        props: expect.objectContaining({
          filter: { 'tag:Name': 'dev-identifier-exchange-vpc' },
        }),
      }),
    );
  });

  test('publishes cluster details for DataMigratorStack and workloads', () => {
    const { template } = synth();
    const getAtt = (prefix: string, attr: string) => ({
      'Fn::GetAtt': [Match.stringLikeRegexp(`^${prefix}`), attr],
    });

    for (const [name, value] of [
      ['/dev-identifier-exchange/dsql/cluster-endpoint', getAtt('Cluster', 'Endpoint')],
      ['/dev-identifier-exchange/dsql/cluster-arn', getAtt('Cluster', 'ResourceArn')],
      [
        '/dev-identifier-exchange/dsql/client-security-group-id',
        getAtt('DsqlClientSecurityGroup', 'GroupId'),
      ],
    ] as const) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name, Value: value });
    }
  });

  test('denies cluster connections from outside the shared VPC', () => {
    const { template } = synth();
    const [cluster] = Object.values(template.findResources('AWS::DSQL::Cluster'));
    const policy = JSON.stringify(cluster?.Properties?.PolicyDocument);

    expect(policy).toContain('DenyConnectionsFromOutsideVpc');
    expect(policy).toContain('aws:SourceVpc');
    expect(policy).toContain(DUMMY_VPC_ID);
  });

  test('places the DSQL interface endpoint in the shared VPC', () => {
    const { template } = synth();

    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      VpcId: DUMMY_VPC_ID,
      PrivateDnsEnabled: true,
      ServiceName: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Cluster'), 'VpcEndpointServiceName'] },
    });
  });

  test('only DSQL client security group can reach the endpoint', () => {
    const { template } = synth();
    const sgId = (prefix: string) => ({
      'Fn::GetAtt': [Match.stringLikeRegexp(`^${prefix}`), 'GroupId'],
    });

    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: DSQL_PORT,
      ToPort: DSQL_PORT,
      GroupId: sgId('DsqlEndpointSecurityGroup'),
      SourceSecurityGroupId: sgId('DsqlClientSecurityGroup'),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      FromPort: DSQL_PORT,
      ToPort: DSQL_PORT,
      GroupId: sgId('DsqlClientSecurityGroup'),
      DestinationSecurityGroupId: sgId('DsqlEndpointSecurityGroup'),
    });
    // Neither group accepts traffic from a CIDR range.
    for (const sg of Object.values(template.findResources('AWS::EC2::SecurityGroup'))) {
      expect(sg.Properties?.SecurityGroupIngress).toBeUndefined();
    }
  });

  test('runs no Lambda-backed resources (migrations live in DataMigratorStack)', () => {
    const { template } = synth();

    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('Custom::AWS', 0);
  });

  test('non-prod cluster is disposable', () => {
    const { template } = synth(GovUkOnceEnvironments.Dev);

    template.hasResource('AWS::DSQL::Cluster', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ DeletionProtectionEnabled: false }),
    });
  });

  test('prod cluster is protected and retained', () => {
    const { template } = synth(GovUkOnceEnvironments.Prod);

    template.hasResource('AWS::DSQL::Cluster', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtectionEnabled: true }),
    });
  });
});
