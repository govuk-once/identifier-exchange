import * as cdk from 'aws-cdk-lib';
import * as dsql from 'aws-cdk-lib/aws-dsql';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ContextHelper } from '../utils/context-helper';
import { SharedResources } from '../utils/shared-resources';
import { importSharedVpc } from '../utils/shared-vpc';

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
 * Encrypted at rest with DSQL's default AWS-owned key (no customer-managed
 * key to pay for or manage).
 *
 * The shared VPC is looked up rather than passed in (see SharedResources), so
 * this stack needs an explicit `env` and NetworkSecurityStack must already be
 * deployed in the target account.
 */
export class DataStack extends cdk.Stack {
  public readonly cluster: dsql.CfnCluster;
  public readonly endpoint: ec2.InterfaceVpcEndpoint;
  /** Attach to any workload that is allowed to connect to the database. */
  public readonly clientSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isProd = ContextHelper.get(this, 'isProd');

    const vpc = importSharedVpc(this);

    this.cluster = new dsql.CfnCluster(this, 'Cluster', {
      deletionProtectionEnabled: isProd,
      // Deny any connection that does not arrive from inside the shared VPC,
      // which closes the cluster's public endpoint.
      policyDocument: this.toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyConnectionsFromOutsideVpc',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: ['dsql:DbConnect', 'dsql:DbConnectAdmin'],
            Resource: '*',
            Condition: { StringNotEquals: { 'aws:SourceVpc': vpc.vpcId } },
          },
        ],
      }),
      tags: [{ key: 'Name', value: ContextHelper.get(this, 'resourceName', 'dsql') }],
    });
    this.cluster.applyRemovalPolicy(isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY);

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
        this.cluster.attrEndpoint,
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
