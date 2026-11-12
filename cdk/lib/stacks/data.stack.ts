import * as cdk from 'aws-cdk-lib';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ContextHelper } from '../utils/context-helper';
import { SharedResources } from '../utils/shared-resources';
import { importSharedVpc } from '../utils/shared-vpc';

/**
 * Roles people use in the console. Outside prod they may connect from
 * outside the VPC, so the DSQL console's "Connect" works. This only lifts the
 * VPC deny: they still need dsql:DbConnect(Admin), and kms:Decrypt on the
 * cluster key, from their own IAM policies.
 */
export const consoleUserRoles = (account: string) => [
  // Personal admin roles assumed into the account, e.g. <firstname.lastname>-admin.
  `arn:aws:iam::${account}:role/*-admin`,
  // IAM Identity Center (SSO) permission sets.
  `arn:aws:iam::${account}:role/aws-reserved/sso.amazonaws.com/*`,
];

/** PostgreSQL wire protocol port that the DSQL endpoint listens on. */
export const DSQL_PORT = 5432;

/**
 * Aurora DSQL cluster, reachable only through a VPC interface endpoint.
 * Schema migrations run from DataMigratorStack.
 *
 * Workloads that need the database attach `clientSecurityGroup`; nothing else
 * can reach the endpoint, and the cluster policy rejects connections that do
 * not come from inside the VPC.
 *
 * Encrypted at rest with the customer-managed DSQL key from
 * NetworkSecurityStack.
 *
 * The shared VPC is looked up rather than passed in (see SharedResources), so
 * this stack needs an explicit `env` and NetworkSecurityStack must already be
 * deployed in the target account.
 */
export class DataStack extends cdk.Stack {
  public readonly cluster: dsql.CfnCluster;
  public readonly endpoint: ec2.InterfaceVpcEndpoint;
  /**
   * Hostname that resolves to the VPC endpoint. Workloads must connect with
   * this, not `cluster.attrEndpoint`, which resolves to a public address that
   * the isolated subnets cannot reach.
   */
  public readonly privateHostname: string;
  /** Attach to any workload that is allowed to connect to the database. */
  public readonly clientSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isProd = ContextHelper.get(this, 'isProd');

    const vpc = importSharedVpc(this);

    // Resolved by CloudFormation at deploy time, like the VPC.
    const encryptionKey = kms.Key.fromKeyArn(
      this,
      'DsqlEncryptionKey',
      ssm.StringParameter.valueForStringParameter(
        this,
        SharedResources.dsqlEncryptionKeyArnParameter(this),
      ),
    );

    this.cluster = new dsql.CfnCluster(this, 'Cluster', {
      kmsEncryptionKey: encryptionKey.keyArn,
      deletionProtectionEnabled: isProd,
      // Deny any connection that does not arrive from inside the shared VPC,
      // which closes the cluster's public endpoint. Outside prod, console
      // users are exempt (conditions in one statement are ANDed).
      policyDocument: this.toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyConnectionsFromOutsideVpc',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: ['dsql:DbConnect', 'dsql:DbConnectAdmin'],
            Resource: '*',
            Condition: {
              StringNotEquals: { 'aws:SourceVpc': vpc.vpcId },
              ...(!isProd && {
                ArnNotLike: { 'aws:PrincipalArn': consoleUserRoles(this.account) },
              }),
            },
          },
        ],
      }),
      tags: [{ key: 'Name', value: ContextHelper.get(this, 'resourceName', 'dsql') }],
    });
    this.cluster.applyRemovalPolicy(isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);

    // PrivateLink hostname: <cluster-id>.<service-suffix>.<region>.on.aws,
    // where the suffix is the last part of the endpoint service name
    // (com.amazonaws.<region>.dsql-xxxx -> dsql-xxxx). Private DNS on the
    // endpoint below resolves it to the endpoint's IPs. The DSQL connector
    // parses the region from this form and signs the auth token for it.
    this.privateHostname = cdk.Fn.join('.', [
      this.cluster.attrIdentifier,
      cdk.Fn.select(3, cdk.Fn.split('.', this.cluster.attrVpcEndpointServiceName)),
      this.region,
      'on.aws',
    ]);

    this.clientSecurityGroup = new ec2.SecurityGroup(this, 'DsqlClientSecurityGroup', {
      vpc,
      securityGroupName: ContextHelper.get(this, 'resourceName', 'dsql-client'),
      description: 'Attach to workloads that are allowed to connect to Aurora DSQL',
      allowAllOutbound: false,
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'DsqlEndpointSecurityGroup', {
      vpc,
      securityGroupName: ContextHelper.get(this, 'resourceName', 'dsql-endpoint'),
      description: 'Aurora DSQL VPC endpoint - ingress from DSQL clients only',
      allowAllOutbound: false,
    });

    this.endpoint = new ec2.InterfaceVpcEndpoint(this, 'DsqlEndpoint', {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(
        this.cluster.attrVpcEndpointServiceName,
        DSQL_PORT,
      ),
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true,
      securityGroups: [endpointSecurityGroup],
      open: false,
    });

    // Adds the ingress rule on the endpoint SG and the matching egress rule on
    // the client SG.
    this.endpoint.connections.allowDefaultPortFrom(
      this.clientSecurityGroup,
      'DSQL clients to DSQL endpoint',
    );

    // Published for DataMigratorStack and application stacks to look up.
    for (const [_id, parameterName, stringValue] of [
      [
        'ClusterEndpointParameter',
        SharedResources.dsqlClusterEndpointParameter(this),
        this.privateHostname,
      ],
      [
        'ClusterArnParameter',
        SharedResources.dsqlClusterArnParameter(this),
        this.cluster.attrResourceArn,
      ],
      [
        'ClientSecurityGroupIdParameter',
        SharedResources.dsqlClientSecurityGroupIdParameter(this),
        this.clientSecurityGroup.securityGroupId,
      ],
    ] as const) {
      new ssm.StringParameter(this, _id, { parameterName, stringValue });
    }
  }
}
