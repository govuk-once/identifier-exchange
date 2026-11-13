import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as signer from 'aws-cdk-lib/aws-signer';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ContextHelper } from '../utils/context-helper.js';
import { SharedResources } from '../utils/shared-resources.js';

// TODO(network engineer sign-off): the CIDR, AZ count and subnet mask are very
// hard to change once deployed. Confirm before the first deploy to any account.

/** Address range of the shared VPC. Nothing outside it is routable. */
export const VPC_CIDR = '10.0.0.0/16';
export const MAX_AZS = 2;
export const SUBNET_CIDR_MASK = 24;
/** Subnet group name, so consumers can select subnets by name as well as type. */
export const ISOLATED_SUBNET_GROUP = 'IsolatedPrivate';

/** Matches the rotation period on UDP's keys. */
export const KEY_ROTATION_PERIOD = cdk.Duration.days(90);

/** PostgreSQL wire protocol port that the DSQL endpoint listens on. */
export const DSQL_PORT = 5432;

/**
 * Aurora DSQL's PrivateLink endpoint service. There is one per Region, shared
 * by every cluster in it (the cluster's VpcEndpointServiceName attribute
 * returns the same value), and its private DNS zone (*.dsql-xxxx.<region>.on.aws)
 * can only be attached to one endpoint per VPC. So the endpoint lives here,
 * once, rather than with each cluster.
 *
 * To add a Region, read the name from any cluster there:
 *   aws dsql get-vpc-endpoint-service-name --identifier <cluster-id>
 */
export const DSQL_ENDPOINT_SERVICE_NAMES: Readonly<Record<string, string>> = {
  'eu-west-2': 'com.amazonaws.eu-west-2.dsql-qxpi',
};

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
 * - Two customer-managed KMS keys, kept apart so each can be granted and
 *   rotated on its own:
 *   - `dsqlEncryptionKey` encrypts the Aurora DSQL cluster at rest.
 *   - `dataEncryptionKey` is for application-level envelope encryption of
 *     individual fields (GenerateDataKey / Decrypt), as UDP's
 *     `db-kms-encryption` key is. Data migrated from UDP is re-encrypted
 *     under this key.
 *
 * Downstream stacks read these resources from the SSM parameters in
 * SharedResources (see importSharedVpc) rather than cross-stack exports, so
 * they resolve at deploy time. The public properties are for same-app wiring
 * and tests.
 */
export class NetworkSecurityStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  /**
   * `vpc` typed as IVpc. aws-cdk-lib's Vpc declares `vpnGatewayId` as
   * `string | undefined`, which exactOptionalPropertyTypes won't assign to
   * IVpc's `vpnGatewayId?: string`, so construct props need the cast.
   */
  private get vpcRef(): ec2.IVpc {
    return this.vpc as ec2.IVpc;
  }
  public readonly networkAcl: ec2.NetworkAcl;
  /** Guards every interface endpoint: HTTPS from inside the VPC only. */
  public readonly endpointSecurityGroup: ec2.SecurityGroup;
  /** Shared DSQL data-plane endpoint for every cluster's connections. */
  public readonly dsqlEndpoint: ec2.InterfaceVpcEndpoint;
  public readonly dsqlEndpointSecurityGroup: ec2.SecurityGroup;
  public readonly signingProfile: signer.SigningProfile;
  public readonly codeSigningConfig: lambda.CodeSigningConfig;
  public readonly dsqlEncryptionKey: kms.Key;
  public readonly dataEncryptionKey: kms.Key;

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
    [this.dsqlEndpoint, this.dsqlEndpointSecurityGroup] = this.createDsqlEndpoint();

    this.signingProfile = new signer.SigningProfile(this, 'SigningProfile', {
      platform: signer.Platform.AWS_LAMBDA_SHA384_ECDSA,
    });
    this.codeSigningConfig = new lambda.CodeSigningConfig(this, 'CodeSigningConfig', {
      description: 'Rejects Lambda deployment packages not signed by the app signing profile',
      signingProfiles: [this.signingProfile],
      untrustedArtifactOnDeployment: lambda.UntrustedArtifactOnDeployment.ENFORCE,
    });

    this.dsqlEncryptionKey = this.createKey(
      'DsqlEncryptionKey',
      'dsql',
      'Aurora DSQL cluster storage',
    );
    this.allowDsqlToUseKey(this.dsqlEncryptionKey);
    this.dataEncryptionKey = this.createKey(
      'DataEncryptionKey',
      'data',
      'Application-level field encryption',
    );

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
        'DsqlEndpointSecurityGroupIdParameter',
        SharedResources.dsqlEndpointSecurityGroupIdParameter(this),
        this.dsqlEndpointSecurityGroup.securityGroupId,
      ],
      [
        'DsqlEncryptionKeyArnParameter',
        SharedResources.dsqlEncryptionKeyArnParameter(this),
        this.dsqlEncryptionKey.keyArn,
      ],
      [
        'DataEncryptionKeyArnParameter',
        SharedResources.dataEncryptionKeyArnParameter(this),
        this.dataEncryptionKey.keyArn,
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
   * Symmetric key with automatic rotation. Retained in prod: anything
   * encrypted under a deleted key is unrecoverable. Access is granted through
   * IAM (the default key policy delegates to the account).
   */
  private createKey(id: string, name: string, purpose: string): kms.Key {
    const isProd = ContextHelper.get(this, 'isProd');
    return new kms.Key(this, id, {
      alias: `${ContextHelper.get(this, 'sharedPrefix')}-${name}`,
      description: `${purpose} - ${ContextHelper.get(this, 'sharedPrefix')}`,
      enableKeyRotation: true,
      rotationPeriod: KEY_ROTATION_PERIOD,
      pendingWindow: cdk.Duration.days(30),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }

  /**
   * Lets Aurora DSQL use the key for clusters in this account only.
   * TODO: verify against the DSQL customer-managed key docs on the first dev
   * deploy; cluster creation fails if DSQL cannot use the key.
   */
  private allowDsqlToUseKey(key: kms.Key): void {
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowAuroraDsql',
        principals: [new iam.ServicePrincipal('dsql.amazonaws.com')],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
  }

  /**
   * Replaces the default (allow-all) NACL on the isolated subnets. NACLs are
   * stateless, so the ingress rule also admits return traffic on ephemeral
   * ports from inside the VPC.
   */
  private createZeroEgressNacl(): ec2.NetworkAcl {
    const nacl = new ec2.NetworkAcl(this, 'ZeroEgressNacl', {
      vpc: this.vpcRef,
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
      vpc: this.vpcRef,
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

  /**
   * One DSQL data-plane endpoint for all clusters in the VPC, with private DNS
   * so each cluster's private hostname resolves to it. Who may connect to a
   * given cluster is decided by IAM and that cluster's policy, not here.
   */
  private createDsqlEndpoint(): [ec2.InterfaceVpcEndpoint, ec2.SecurityGroup] {
    const region = this.region;
    const serviceName = cdk.Token.isUnresolved(region)
      ? undefined
      : DSQL_ENDPOINT_SERVICE_NAMES[region];
    if (!serviceName) {
      throw new Error(
        `No Aurora DSQL endpoint service name for region "${region}". ` +
          'Add it to DSQL_ENDPOINT_SERVICE_NAMES (and give the stack an explicit env).',
      );
    }

    const securityGroup = new ec2.SecurityGroup(this, 'DsqlEndpointSecurityGroup', {
      vpc: this.vpcRef,
      description: 'Aurora DSQL data-plane endpoint - PostgreSQL from inside the VPC only',
      allowAllOutbound: false,
    });
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(VPC_CIDR),
      ec2.Port.tcp(DSQL_PORT),
      'PostgreSQL from inside the VPC',
    );

    const endpoint = this.vpc.addInterfaceEndpoint('DsqlDataEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(serviceName, DSQL_PORT),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true,
      securityGroups: [securityGroup],
      open: false,
    });
    return [endpoint, securityGroup];
  }
}
