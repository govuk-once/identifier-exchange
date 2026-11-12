import * as cdk from 'aws-cdk-lib';
import { describe, expect, test } from 'vitest';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { DSQL_PORT, DataStack } from './data.stack';
import { ContextHelper } from '../utils/context-helper';
import { GovUkOnceEnvironments } from '../constants/environment';
import { TEST_ENV, sharedSubnetIds, sharedVpcId, ssmRef } from '../testing/helpers';

const synth = (environment = GovUkOnceEnvironments.Dev) => {
  const app = new cdk.App();
  ContextHelper.setAll(app, { environment, appName: 'identifier-exchange' });
  const dataStack = new DataStack(app, 'TestDataStack', { env: TEST_ENV });
  return { app, dataStack, template: Template.fromStack(dataStack) };
};

describe('Data Stack', () => {
  test('creates one DSQL cluster encrypted with the shared customer-managed key', () => {
    const { template } = synth();

    template.resourceCountIs('AWS::DSQL::Cluster', 1);
    template.hasResourceProperties('AWS::DSQL::Cluster', {
      KmsEncryptionKey: ssmRef(template, '/dev-identifier-exchange/kms/dsql-encryption-key-arn'),
    });
  });

  test('reads the shared VPC from SSM at deploy time, not by synth-time lookup or export', () => {
    const { app, template } = synth();

    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    // Synthesizes without asking the CDK CLI to look anything up in the account.
    expect(app.synth().manifest.missing ?? []).toEqual([]);
    sharedVpcId(template);
    sharedSubnetIds(template);
  });

  test('publishes cluster details for DataMigratorStack and workloads', () => {
    const { template } = synth();
    const getAtt = (prefix: string, attr: string) => ({
      'Fn::GetAtt': [Match.stringLikeRegexp(`^${prefix}`), attr],
    });

    for (const [name, value] of [
      [
        '/dev-identifier-exchange/dsql/cluster-endpoint',
        {
          'Fn::Join': [
            '.',
            [
              getAtt('Cluster', 'Identifier'),
              {
                'Fn::Select': [
                  3,
                  { 'Fn::Split': ['.', getAtt('Cluster', 'VpcEndpointServiceName')] },
                ],
              },
              'eu-west-2',
              'on.aws',
            ],
          ],
        },
      ],
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
    expect(policy).toContain(JSON.stringify(sharedVpcId(template)));
  });

  test('places the DSQL interface endpoint in the isolated subnets of the shared VPC', () => {
    const { template } = synth();

    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      VpcId: sharedVpcId(template),
      SubnetIds: sharedSubnetIds(template),
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
