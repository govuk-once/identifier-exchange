import * as cdk from 'aws-cdk-lib';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ContextHelper } from '../utils/context-helper.js';
import { SharedResources } from '../utils/shared-resources.js';
import { importSharedVpc } from '../utils/shared-vpc.js';
import { DSQL_PORT } from './network-security.stack.js';

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

export { DSQL_PORT } from './network-security.stack.js';

/**
 * Aurora DSQL cluster, reachable only through the shared DSQL VPC endpoint
 * in NetworkSecurityStack. Schema migrations run from DataMigratorStack.
 *
 * Workloads that need the database attach `clientSecurityGroup`, which may
 * reach the endpoint; the cluster policy rejects connections that do not come
 * from inside the VPC, and IAM decides which roles may connect to this
 * cluster.
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
    // shared endpoint in NetworkSecurityStack resolves it to that endpoint. The DSQL connector
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

    // The endpoint is shared by every cluster in the VPC (see
    // NetworkSecurityStack), so clients reach it through its security group.
    const endpointSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DsqlEndpointSecurityGroup',
      ssm.StringParameter.valueForStringParameter(
        this,
        SharedResources.dsqlEndpointSecurityGroupIdParameter(this),
      ),
      { mutable: false },
    );
    this.clientSecurityGroup.addEgressRule(
      ec2.Peer.securityGroupId(endpointSecurityGroup.securityGroupId),
      ec2.Port.tcp(DSQL_PORT),
      'DSQL clients to the shared DSQL endpoint',
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
