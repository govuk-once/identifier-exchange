import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as signer from 'aws-cdk-lib/aws-signer';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { SharedResources } from '../utils/shared-resources';

// TODO(network engineer sign-off): the CIDR, AZ count and subnet mask are very
// hard to change once deployed. Confirm before the first deploy to any account.

/** Address range of the shared VPC. Nothing outside it is routable. */
export const VPC_CIDR = '10.0.0.0/16';
export const MAX_AZS = 2;
export const SUBNET_CIDR_MASK = 24;
/** Subnet group name, so consumers can select subnets by name as well as type. */
export const ISOLATED_SUBNET_GROUP = 'IsolatedPrivate';

const HTTPS_PORT = 443;
const ANY_IPV4 = '0.0.0.0/0';

/**
 * Zero-trust network and code-signing boundary for the service.
 *
 * - VPC with isolated private subnets only: no Internet Gateway, no NAT, no
 *   route to 0.0.0.0/0.
 * - A NACL that allows traffic to and from the VPC CIDR and explicitly denies
 *   everything else, in both directions.
 * - PrivateLink endpoints for the AWS APIs workloads need, plus an S3 gateway
 *   endpoint. The per-cluster DSQL data-plane endpoint lives in DataStack.
 * - An AWS Signer profile and a Lambda code-signing config in ENFORCE mode.
 *
 * Encryption at rest uses each service's default AWS-owned/managed key, so
 * there is no customer-managed key here.
 *
 * Downstream stacks read these resources from the SSM parameters in
 * SharedResources (see importSharedVpc) rather than cross-stack exports, so
 * they resolve at deploy time. The public properties are for same-app wiring
 * and tests.
 */
export class NetworkSecurityStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly networkAcl: ec2.NetworkAcl;
  /** Guards every interface endpoint: HTTPS from inside the VPC only. */
  public readonly endpointSecurityGroup: ec2.SecurityGroup;
  public readonly signingProfile: signer.SigningProfile;
  public readonly codeSigningConfig: lambda.CodeSigningConfig;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: SharedResources.vpcName(this),
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      maxAzs: MAX_AZS,
      natGateways: 0,
      createInternetGateway: false,
      subnetConfiguration: [
        {
          name: ISOLATED_SUBNET_GROUP,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: SUBNET_CIDR_MASK,
        },
      ],
    });

    this.networkAcl = this.createZeroEgressNacl();
    this.endpointSecurityGroup = this.createEndpoints();

    this.signingProfile = new signer.SigningProfile(this, 'SigningProfile', {
      platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
    });
    this.codeSigningConfig = new lambda.CodeSigningConfig(this, 'CodeSigningConfig', {
      description: 'Rejects Lambda deployment packages not signed by the app signing profile',
      signingProfiles: [this.signingProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.ENFORCE,
    });

    const isolatedSubnets = this.vpc.isolatedSubnets;
    for (const [parameterId, parameterName, stringValue] of [
      // Read back by importSharedVpc. AZs come from the subnets so the two
      // lists stay in the same order.
      ['VpcIdParameter', SharedResources.vpcIdParameter(this), this.vpc.vpcId],
      [
        'IsolatedSubnetIdsParameter',
        SharedResources.isolatedSubnetIdsParameter(this),
        cdk.Fn.join(
          ',',
          isolatedSubnets.map((s) => s.subnetId),
        ),
      ],
      [
        'AvailabilityZonesParameter',
        SharedResources.availabilityZonesParameter(this),
        cdk.Fn.join(
          ',',
          isolatedSubnets.map((s) => s.availabilityZone),
        ),
      ],
      [
        'CodeSigningConfigArnParameter',
        SharedResources.codeSigningConfigArnParameter(this),
        this.codeSigningConfig.codeSigningConfigArn,
      ],
      [
        'SigningProfileNameParameter',
        SharedResources.signingProfileNameParameter(this),
        this.signingProfile.signingProfileName,
      ],
    ] as const) {
      new ssm.StringParameter(this, parameterId, { parameterName, stringValue });
    }
  }

  /**
   * Replaces the default (allow-all) NACL on the isolated subnets. NACLs are
   * stateless, so the ingress rule also admits return traffic on ephemeral
   * ports from inside the VPC.
   */
  private createZeroEgressNacl(): ec2.NetworkAcl {
    const nacl = new ec2.NetworkAcl(this, 'ZeroEgressNacl', {
      vpc: this.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    for (const direction of [ec2.TrafficDirection.INGRESS, ec2.TrafficDirection.EGRESS]) {
      const label = direction === ec2.TrafficDirection.INGRESS ? 'Inbound' : 'Outbound';
      nacl.addEntry(`Allow${label}VpcCidr`, {
        ruleNumber: 100,
        cidr: ec2.AclCidr.ipv4(VPC_CIDR),
        traffic: ec2.AclTraffic.allTraffic(),
        direction,
        ruleAction: ec2.Action.ALLOW,
      });
      // The implicit `*` rule already denies this; the explicit rule makes the
      // intent visible in the console and in the template.
      nacl.addEntry(`Deny${label}Internet`, {
        ruleNumber: 200,
        cidr: ec2.AclCidr.ipv4(ANY_IPV4),
        traffic: ec2.AclTraffic.allTraffic(),
        direction,
        ruleAction: ec2.Action.DENY,
      });
    }
    return nacl;
  }

  /** PrivateLink endpoints for AWS APIs, plus the S3 gateway endpoint. */
  private createEndpoints(): ec2.SecurityGroup {
    const subnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'AWS service interface endpoints - HTTPS from inside the VPC only',
      allowAllOutbound: false,
    });
    endpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(VPC_CIDR),
      ec2.Port.tcp(HTTPS_PORT),
      'HTTPS from inside the VPC',
    );

    for (const [endpointId, service] of [
      ['KmsEndpoint', ec2.InterfaceVpcEndpointAwsService.KMS],
      ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['DsqlEndpoint', new ec2.InterfaceVpcEndpointAwsService('dsql')],
    ] as const) {
      this.vpc.addInterfaceEndpoint(endpointId, {
        service,
        subnets,
        privateDnsEnabled: true,
        securityGroups: [endpointSecurityGroup],
        open: false,
      });
    }

    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [subnets],
    });

    return endpointSecurityGroup;
  }
}
