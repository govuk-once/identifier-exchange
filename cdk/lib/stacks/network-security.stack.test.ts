import * as cdk from 'aws-cdk-lib';
import { describe, expect, test } from 'vitest';

import { Match, Template } from 'aws-cdk-lib/assertions';
import { MAX_AZS, NetworkSecurityStack, VPC_CIDR } from './network-security.stack';
import { ContextHelper } from '../utils/context-helper';
import { GovUkOnceEnvironments } from '../constants/environment';
import { TEST_ENV } from '../testing/helpers';

const synth = (environment = GovUkOnceEnvironments.Dev) => {
  const app = new cdk.App();
  ContextHelper.setAll(app, { environment, appName: 'identifier-exchange' });
  const stack = new NetworkSecurityStack(app, 'TestNetworkSecurityStack', { env: TEST_ENV });
  return { stack, template: Template.fromStack(stack) };
};

const getAtt = (prefix: string, attr: string) => ({
  'Fn::GetAtt': [Match.stringLikeRegexp(`^${prefix}`), attr],
});

/**
 * Every VPC endpoint, with its service name flattened for matching. The name
 * is a literal or an Fn::Join on the region; both end the service segment
 * with `.<service>"` once stringified.
 */
const endpoints = (template: Template) =>
  Object.values(template.findResources('AWS::EC2::VPCEndpoint')).map((r) => ({
    type: r.Properties.VpcEndpointType as string,
    service: JSON.stringify(r.Properties.ServiceName),
    properties: r.Properties,
  }));

describe('Network Security Stack', () => {
  describe('VPC', () => {
    test('is named for lookup by downstream stacks', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.hasResourceProperties('AWS::EC2::VPC', {
        CidrBlock: VPC_CIDR,
        Tags: Match.arrayWith([{ Key: 'Name', Value: 'dev-identifier-exchange-vpc' }]),
      });
    });

    test('has no internet gateway, NAT or routes out of the VPC', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::EC2::InternetGateway', 0);
      template.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 0);
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::EIP', 0);
      template.resourceCountIs('AWS::EC2::Route', 0);
    });

    test(`has one isolated private subnet in each of ${MAX_AZS} AZs`, () => {
      const { template } = synth();

      template.resourceCountIs('AWS::EC2::Subnet', MAX_AZS);
      for (const subnet of Object.values(template.findResources('AWS::EC2::Subnet'))) {
        expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false);
        expect(subnet.Properties.Tags).toContainEqual({
          Key: 'aws-cdk:subnet-type',
          Value: 'Isolated',
        });
      }
    });
  });

  describe('NACL', () => {
    test('is attached to every isolated subnet', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::EC2::NetworkAcl', 1);
      template.resourceCountIs('AWS::EC2::SubnetNetworkAclAssociation', MAX_AZS);
      template.allResourcesProperties('AWS::EC2::SubnetNetworkAclAssociation', {
        NetworkAclId: { Ref: Match.stringLikeRegexp('^ZeroEgressNacl') },
      });
    });

    test.each([
      ['inbound', false],
      ['outbound', true],
    ])('allows %s traffic to and from the VPC CIDR only', (_, egress) => {
      const { template } = synth();

      template.hasResourceProperties('AWS::EC2::NetworkAclEntry', {
        Egress: egress,
        RuleNumber: 100,
        CidrBlock: VPC_CIDR,
        Protocol: -1,
        RuleAction: 'allow',
      });
      template.hasResourceProperties('AWS::EC2::NetworkAclEntry', {
        Egress: egress,
        RuleNumber: 200,
        CidrBlock: '0.0.0.0/0',
        Protocol: -1,
        RuleAction: 'deny',
      });
    });

    test('allows nothing outside the VPC CIDR', () => {
      const { template } = synth();
      const entries = Object.values(template.findResources('AWS::EC2::NetworkAclEntry'));

      expect(entries).toHaveLength(4);
      for (const { Properties: entry } of entries) {
        if (entry.RuleAction === 'allow') expect(entry.CidrBlock).toBe(VPC_CIDR);
      }
    });
  });

  describe('VPC endpoints', () => {
    test.each(['kms', 'logs', 'secretsmanager', 'dsql'])(
      'has a private-DNS interface endpoint for %s in the isolated subnets',
      (service) => {
        const { template } = synth();
        const endpoint = endpoints(template).find(
          (e) => e.type === 'Interface' && e.service.includes(`.${service}"`),
        );

        expect(endpoint, `no ${service} endpoint`).toBeDefined();
        expect(endpoint?.properties).toMatchObject({
          PrivateDnsEnabled: true,
          // Plain vitest matcher: toMatchObject does not understand CDK's Match.
          SecurityGroupIds: [
            { 'Fn::GetAtt': [expect.stringMatching(/^EndpointSecurityGroup/), 'GroupId'] },
          ],
        });
        expect(endpoint?.properties.SubnetIds).toHaveLength(MAX_AZS);
      },
    );

    test('has an S3 gateway endpoint on the isolated route tables', () => {
      const { template } = synth();
      const gateways = endpoints(template).filter((e) => e.type === 'Gateway');

      expect(gateways).toHaveLength(1);
      expect(gateways[0]?.service).toContain('.s3"');
      expect(gateways[0]?.properties.RouteTableIds).toHaveLength(MAX_AZS);
    });

    test('creates no other endpoints', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::EC2::VPCEndpoint', 5);
    });

    test('endpoint security group accepts HTTPS from the VPC CIDR only', () => {
      const { template } = synth();
      const groups = template.findResources('AWS::EC2::SecurityGroup', {
        Properties: { GroupDescription: Match.stringLikeRegexp('interface endpoints') },
      });
      const [group] = Object.values(groups);

      expect(group?.Properties.SecurityGroupIngress).toEqual([
        expect.objectContaining({
          CidrIp: VPC_CIDR,
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
        }),
      ]);
      // allowAllOutbound: false leaves CDK's placeholder rule, which matches no traffic.
      expect(group?.Properties.SecurityGroupEgress).toEqual([
        expect.objectContaining({ CidrIp: '255.255.255.255/32' }),
      ]);
    });
  });

  describe('Code signing', () => {
    test('signs with the Lambda SHA384 ECDSA platform', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::Signer::SigningProfile', 1);
      template.hasResourceProperties('AWS::Signer::SigningProfile', {
        PlatformId: 'AWSLambda-SHA384-ECDSA',
      });
    });

    test('rejects unsigned deployment packages', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::Lambda::CodeSigningConfig', 1);
      template.hasResourceProperties('AWS::Lambda::CodeSigningConfig', {
        AllowedPublishers: {
          SigningProfileVersionArns: [getAtt('SigningProfile', 'ProfileVersionArn')],
        },
        CodeSigningPolicies: { UntrustedArtifactOnDeployment: 'Enforce' },
      });
    });

    test('exposes the config to same-app stacks', () => {
      const { stack } = synth();

      expect(stack.codeSigningConfig.codeSigningConfigArn).toBeDefined();
    });
  });

  test('publishes the VPC for importSharedVpc', () => {
    const { template } = synth();
    const subnetRefs = Array.from({ length: MAX_AZS }, () => ({
      Ref: Match.stringLikeRegexp('^VpcIsolatedPrivateSubnet'),
    }));

    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dev-identifier-exchange/network/vpc-id',
      Value: { Ref: Match.stringLikeRegexp('^Vpc') },
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dev-identifier-exchange/network/isolated-subnet-ids',
      Value: { 'Fn::Join': [',', subnetRefs] },
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/dev-identifier-exchange/network/availability-zones',
      Value: Match.anyValue(),
    });
  });

  test('publishes code signing details for downstream stacks and the pipeline', () => {
    const { template } = synth();

    for (const [name, value] of [
      [
        '/dev-identifier-exchange/code-signing/config-arn',
        getAtt('CodeSigningConfig', 'CodeSigningConfigArn'),
      ],
      // Literal or GetAtt, depending on the signingProfileNamePassedToCfn flag.
      ['/dev-identifier-exchange/code-signing/signing-profile-name', Match.anyValue()],
    ] as const) {
      template.hasResourceProperties('AWS::SSM::Parameter', { Name: name, Value: value });
    }
  });

  describe('KMS keys', () => {
    const KEYS = [
      ['DsqlEncryptionKey', 'dsql', '/dev-identifier-exchange/kms/dsql-encryption-key-arn'],
      ['DataEncryptionKey', 'data', '/dev-identifier-exchange/kms/data-encryption-key-arn'],
    ] as const;

    test('creates a separate key for DSQL storage and for field encryption', () => {
      const { template } = synth();

      template.resourceCountIs('AWS::KMS::Key', KEYS.length);
    });

    test.each(KEYS)('%s rotates every 90 days and has an alias', (id, name) => {
      const { template } = synth();

      template.hasResourceProperties('AWS::KMS::Key', {
        EnableKeyRotation: true,
        RotationPeriodInDays: 90,
      });
      template.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: `alias/dev-identifier-exchange-${name}`,
        TargetKeyId: getAtt(id, 'Arn'),
      });
    });

    test.each(KEYS)('publishes the %s ARN for downstream stacks', (id, _, parameterName) => {
      const { template } = synth();

      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: parameterName,
        Value: getAtt(id, 'Arn'),
      });
    });

    test('only the DSQL key can be used by the DSQL service, from this account', () => {
      const { template } = synth();
      const keys = template.findResources('AWS::KMS::Key');
      const policyFor = (prefix: string) =>
        JSON.stringify(
          Object.entries(keys).find(([logicalId]) => logicalId.startsWith(prefix))?.[1]?.Properties
            .KeyPolicy,
        );

      expect(policyFor('DsqlEncryptionKey')).toContain('dsql.amazonaws.com');
      expect(policyFor('DsqlEncryptionKey')).toContain('aws:SourceAccount');
      expect(policyFor('DataEncryptionKey')).not.toContain('dsql.amazonaws.com');
    });

    test('keys are deleted with the stack outside prod', () => {
      const { template } = synth(GovUkOnceEnvironments.Dev);

      template.allResources('AWS::KMS::Key', { DeletionPolicy: 'Delete' });
    });

    test('keys are retained in prod', () => {
      const { template } = synth(GovUkOnceEnvironments.Prod);

      template.allResources('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
    });
  });

  test('uses no cross-stack exports', () => {
    const { template } = synth();

    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });
});
