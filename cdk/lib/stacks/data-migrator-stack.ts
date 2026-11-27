import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as triggers from 'aws-cdk-lib/triggers';
import type { Construct } from 'constructs';
import { ContextHelper } from '../utils/context-helper.js';
import { SharedResources } from '../utils/shared-resources.js';
import { importSharedVpc } from '../utils/shared-vpc.js';
import { GDSEnv } from '@govuk-connect/dev';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');

/** Upper bound for one run. DSQL DDL is quick, but async index builds are awaited. */
const MIGRATION_TIMEOUT = cdk.Duration.minutes(10);

/**
 * Runs the TypeScript migrations in src/db/migrations against the Aurora DSQL
 * cluster from DataStack.
 *
 * - Deploy time: a Trigger invokes the migrator whenever its code (and so its
 *   bundled migrations) changes, and fails the deployment if migrations fail.
 * - On demand: invoke the function by name from CI/CD or the AWS CLI with
 *   `{"action": "up" | "down" | "status", "steps"?: n}`.
 *
 * Also owns the IAM roles that the migrations map to the `readonly_role` and
 * `readwrite_role` database roles. Application workloads use these roles
 * (looked up from SSM) to connect with `dsql:DbConnect`, and to encrypt and
 * decrypt fields with the shared data encryption key.
 *
 * Shared resources are looked up rather than passed in (see SharedResources),
 * so VpcStack and DataStack must be deployed first.
 */
export class DataMigratorStack extends cdk.Stack {
  public readonly migrator: nodejs.NodejsFunction;
  public readonly readOnlyRole: iam.Role;
  public readonly readWriteRole: iam.Role;
  public readonly deleteRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = importSharedVpc(this);

    const lookup = (parameterName: string) =>
      ssm.StringParameter.valueForStringParameter(this, parameterName);
    const clusterArn = lookup(SharedResources.dsqlClusterArnParameter(this));
    const clusterEndpoint = lookup(SharedResources.dsqlClusterEndpointParameter(this));
    // The cluster is encrypted with a customer-managed key, so DSQL refuses a
    // connection unless the connecting principal can also kms:Decrypt with it.
    const dsqlEncryptionKey = kms.Key.fromKeyArn(
      this,
      'DsqlEncryptionKey',
      lookup(SharedResources.dsqlEncryptionKeyArnParameter(this)),
    );
    // Application-level field encryption (envelope encryption with
    // GenerateDataKey, or Encrypt/Decrypt directly) by workloads using the roles.
    const dataEncryptionKey = kms.Key.fromKeyArn(
      this,
      'DataEncryptionKey',
      lookup(SharedResources.dataEncryptionKeyArnParameter(this)),
    );
    const dsqlClientSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DsqlClientSecurityGroup',
      lookup(SharedResources.dsqlClientSecurityGroupIdParameter(this)),
      { mutable: false },
    );

    const workloadRole = (
      roleId: string,
      name: string,
      description: string,
      { dataKeyAccess = true }: { dataKeyAccess?: boolean } = {},
    ) => {
      const role = new iam.Role(this, roleId, {
        roleName: ContextHelper.get(this, 'resourceName', name),
        description,
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('lambda.amazonaws.com'),
          new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        ),
        // Lambda functions using the role run in the VPC (ExchangeApiStack) and
        // need to manage their ENIs and write logs.
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaVPCAccessExecutionRole',
          ),
        ],
      });
      role.addToPolicy(
        new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [clusterArn] }),
      );
      dsqlEncryptionKey.grantDecrypt(role);
      if (dataKeyAccess) {
        // Encrypt, Decrypt, ReEncrypt* and GenerateDataKey* on this key only.
        dataEncryptionKey.grantEncryptDecrypt(role);
      }
      return role;
    };
    this.readOnlyRole = workloadRole(
      'ReadOnlyDbRole',
      'dsql-readonly',
      'Connects to Aurora DSQL as readonly_role',
    );
    this.readWriteRole = workloadRole(
      'ReadWriteDbRole',
      'dsql-readwrite',
      'Connects to Aurora DSQL as readwrite_role',
    );
    // Deleting rows never needs a value decrypted, so no data key access.
    this.deleteRole = workloadRole(
      'DeleteDbRole',
      'dsql-delete',
      'Connects to Aurora DSQL as delete_role',
      { dataKeyAccess: false },
    );

    const functionName = ContextHelper.get(this, 'resourceName', 'data-migrator');
    this.migrator = new nodejs.NodejsFunction(this, 'Migrator', {
      functionName,
      description: 'Applies Aurora DSQL schema migrations',
      entry: path.join(REPO_ROOT, 'src', 'db', 'migrator', 'migrator-handler.ts'),
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: MIGRATION_TIMEOUT,
      // One run at a time: a deploy-time run and a manual run must never
      // race on the schema or the tracking table.
      reservedConcurrentExecutions: 1,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dsqlClientSecurityGroup],
      environment: {
        CLUSTER_ENDPOINT: clusterEndpoint,
        READ_ONLY_ROLE_ARN: this.readOnlyRole.roleArn,
        READ_WRITE_ROLE_ARN: this.readWriteRole.roleArn,
        DELETE_ROLE_ARN: this.deleteRole.roleArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        // Bundle the AWS SDK (the DSQL signer is not in the Lambda runtime)
        // and leave out pg's optional native binding.
        externalModules: ['pg-native'],
        minify: true,
        sourceMap: true,
      },
      logGroup: new logs.LogGroup(this, 'MigratorLogs', {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: GDSEnv.isProd() ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.THREE_MONTHS,
        removalPolicy:
          GDSEnv.isProd() || GDSEnv.isStage()
            ? cdk.RemovalPolicy.RETAIN
            : cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Admin is needed to create roles and run AWS IAM GRANT; DbConnect alone
    // would only allow connecting as a custom database role.
    this.migrator.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dsql:DbConnectAdmin'],
        resources: [clusterArn],
      }),
    );
    dsqlEncryptionKey.grantDecrypt(this.migrator);

    // Re-runs whenever the function's code or configuration changes, which
    // includes every new migration file.
    new triggers.Trigger(this, 'RunMigrationsOnDeploy', {
      handler: this.migrator,
      timeout: MIGRATION_TIMEOUT,
      invocationType: triggers.InvocationType.REQUEST_RESPONSE,
      executeAfter: [this.readOnlyRole, this.readWriteRole, this.deleteRole],
    });

    for (const [parameterId, parameterName, stringValue] of [
      [
        'ReadOnlyRoleArnParameter',
        SharedResources.dsqlReadOnlyRoleArnParameter(this),
        this.readOnlyRole.roleArn,
      ],
      [
        'ReadWriteRoleArnParameter',
        SharedResources.dsqlReadWriteRoleArnParameter(this),
        this.readWriteRole.roleArn,
      ],
      [
        'DeleteRoleArnParameter',
        SharedResources.dsqlDeleteRoleArnParameter(this),
        this.deleteRole.roleArn,
      ],
      [
        'MigratorFunctionNameParameter',
        SharedResources.migratorFunctionNameParameter(this),
        this.migrator.functionName,
      ],
    ] as const) {
      new ssm.StringParameter(this, parameterId, { parameterName, stringValue });
    }

    new cdk.CfnOutput(this, 'MigratorFunctionArn', {
      value: this.migrator.functionArn,
      description: 'Invoke with {"action":"up"|"down"|"status","steps"?:n}',
    });
    new cdk.CfnOutput(this, 'MigratorFunctionName', { value: this.migrator.functionName });
  }
}
