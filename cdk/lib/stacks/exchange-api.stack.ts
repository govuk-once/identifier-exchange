import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { RouteDefinition } from '../../../src/routes/define-route.js';
import { routes as allRoutes } from '../../../src/routes/index.js';
import { createRoute } from '../api/create-route.js';
import { API_STAGE_NAME } from '../api/exchange-api-spec.js';
import { addStandardGatewayResponses } from '../api/gateway-responses.js';
import { ContextHelper } from '../utils/context-helper.js';
import { SharedResources } from '../utils/shared-resources.js';
import { importSharedVpc } from '../utils/shared-vpc.js';

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');

export { API_STAGE_NAME } from '../api/exchange-api-spec.js';

export interface ExchangeApiStackProps extends cdk.StackProps {
  /** Routes to expose. Defaults to every route in src/routes/index.ts. */
  routes?: readonly RouteDefinition[];
  /**
   * execute-api VPC endpoints in consumers' own VPCs (possibly other
   * accounts) that may reach the API, besides the shared VPC's endpoint.
   */
  consumerVpcEndpointIds?: readonly string[];
  /**
   * Other AWS accounts whose IAM principals may invoke the API (still only
   * through an allowed endpoint, and still SigV4-signed). Principals in this
   * account need execute-api:Invoke in their own IAM policy.
   */
  invokerAccountIds?: readonly string[];
}

/** `getItem` -> `get-item`. */
const kebabCase = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * Private REST API for the identifier exchange, reachable only through
 * allowed execute-api VPC endpoints and only with SigV4-signed requests (the
 * same model as user-data-platform). Each route in src/routes becomes an API
 * Gateway method backed by its own Lambda function:
 *
 * - request bodies and required parameters are validated by API Gateway
 *   against the route's Zod schemas (see createRoute), so malformed requests
 *   never reach Lambda;
 * - every error API Gateway generates has the same JSON shape as handler
 *   errors (see addStandardGatewayResponses);
 * - functions run in the shared VPC's isolated subnets with the DSQL client
 *   security group, as the read-only or read-write database role from
 *   DataMigratorStack, which can also encrypt and decrypt with the data key;
 * - each function logs JSON to its own CloudWatch log group with retention.
 *
 * Upstream resources are looked up from SSM rather than passed in (see
 * SharedResources), so NetworkSecurityStack, DataStack and DataMigratorStack
 * must be deployed first.
 */
export class ExchangeApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  /** Keyed by route operationId. */
  public readonly handlers: Readonly<Record<string, nodejs.NodejsFunction>>;
  /**
   * For application-level field encryption. DataMigratorStack grants both
   * database roles Encrypt, Decrypt and GenerateDataKey on it.
   */
  public readonly dataEncryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: ExchangeApiStackProps = {}) {
    super(scope, id, props);

    const isProd = ContextHelper.get(this, 'isProd');
    const vpc = importSharedVpc(this);
    const lookup = (parameterName: string) =>
      ssm.StringParameter.valueForStringParameter(this, parameterName);

    this.dataEncryptionKey = kms.Key.fromKeyArn(
      this,
      'DataEncryptionKey',
      lookup(SharedResources.dataEncryptionKeyArnParameter(this)),
    );
    const clusterEndpoint = lookup(SharedResources.dsqlClusterEndpointParameter(this));
    const dsqlClientSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'DsqlClientSecurityGroup',
      lookup(SharedResources.dsqlClientSecurityGroupIdParameter(this)),
      { mutable: false },
    );
    // Owned by DataMigratorStack, which grants them DSQL access and Lambda VPC
    // execution. Immutable, so this stack cannot widen their permissions.
    const databaseRoles: Record<RouteDefinition['handler']['databaseAccess'], iam.IRole> = {
      readonly: iam.Role.fromRoleArn(
        this,
        'ReadOnlyDbRole',
        lookup(SharedResources.dsqlReadOnlyRoleArnParameter(this)),
        { mutable: false },
      ),
      readwrite: iam.Role.fromRoleArn(
        this,
        'ReadWriteDbRole',
        lookup(SharedResources.dsqlReadWriteRoleArnParameter(this)),
        { mutable: false },
      ),
    };

    const routes = props.routes ?? allRoutes;
    if (routes.length === 0) {
      // API Gateway cannot deploy a REST API with no methods.
      throw new Error('ExchangeApiStack needs at least one route in src/routes/index.ts');
    }

    const executeApiEndpoint = ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(
      this,
      'ExecuteApiEndpoint',
      { vpcEndpointId: lookup(SharedResources.executeApiEndpointIdParameter(this)), port: 443 },
    );
    const allowedVpcEndpointIds = [
      executeApiEndpoint.vpcEndpointId,
      ...(props.consumerVpcEndpointIds ?? []),
    ];

    this.api = new apigateway.RestApi(this, 'ExchangeApi', {
      restApiName: ContextHelper.get(this, 'resourceName', 'exchange-api'),
      description: 'Identifier exchange API (private, SigV4 only)',
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [executeApiEndpoint],
      },
      policy: new iam.PolicyDocument({
        statements: [
          // Checked before authorization: a request through any other endpoint
          // is refused whoever signed it.
          new iam.PolicyStatement({
            sid: 'DenyOutsideAllowedVpcEndpoints',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: { StringNotEquals: { 'aws:SourceVpce': allowedVpcEndpointIds } },
          }),
          // Delegates to IAM in this account (and any listed accounts): a
          // caller also needs execute-api:Invoke in its own policy.
          new iam.PolicyStatement({
            sid: 'AllowSignedRequestsFromAllowedAccounts',
            effect: iam.Effect.ALLOW,
            principals: [this.account, ...(props.invokerAccountIds ?? [])].map(
              (account) => new iam.AccountPrincipal(account),
            ),
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: { StringEquals: { 'aws:SourceVpce': allowedVpcEndpointIds } },
          }),
        ],
      }),
      deployOptions: { stageName: API_STAGE_NAME },
      // The API Gateway CloudWatch role is one per account and region; an
      // isolated (PR) stack must not create or delete it.
      cloudWatchRole: false,
    });
    addStandardGatewayResponses(this.api);

    const handlers: Record<string, nodejs.NodejsFunction> = {};
    for (const route of routes) {
      const name = kebabCase(route.operationId);
      if (handlers[route.operationId]) {
        throw new Error(`Duplicate route operationId: ${route.operationId}`);
      }
      const functionName = ContextHelper.get(this, 'resourceName', `api-${name}`);
      const constructId = route.operationId.charAt(0).toUpperCase() + route.operationId.slice(1);

      const handler = new nodejs.NodejsFunction(this, `${constructId}Handler`, {
        functionName,
        description: `${route.method} ${route.path}: ${route.summary}`,
        entry: path.join(REPO_ROOT, route.handler.entry),
        projectRoot: REPO_ROOT,
        depsLockFilePath: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: cdk.Duration.seconds(10),
        role: databaseRoles[route.handler.databaseAccess],
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [dsqlClientSecurityGroup],
        environment: {
          CLUSTER_ENDPOINT: clusterEndpoint,
          DATA_ENCRYPTION_KEY_ARN: this.dataEncryptionKey.keyArn,
          POWERTOOLS_SERVICE_NAME: 'exchange-api',
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: {
          externalModules: ['pg-native'],
          minify: true,
          sourceMap: true,
        },
        // One structured JSON line per log entry, so CloudWatch Logs Insights
        // can query fields. Lambda passes the level to Powertools Logger via
        // AWS_LAMBDA_LOG_LEVEL and drops anything below it.
        loggingFormat: lambda.LoggingFormat.JSON,
        applicationLogLevelV2: isProd
          ? lambda.ApplicationLogLevel.INFO
          : lambda.ApplicationLogLevel.DEBUG,
        systemLogLevelV2: lambda.SystemLogLevel.WARN,
        // Created here rather than by Lambda on first invoke, so retention is
        // set and the group goes away with the stack (kept in prod). The
        // role's AWSLambdaVPCAccessExecutionRole policy allows writing to it.
        logGroup: new logs.LogGroup(this, `${constructId}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        }),
      });
      createRoute(this.api, route, handler);
      handlers[route.operationId] = handler;
    }
    this.handlers = handlers;

    new cdk.CfnOutput(this, 'ExchangeApiUrl', {
      value: this.api.url,
      description: 'Resolves only inside a VPC with an allowed execute-api endpoint (private DNS)',
    });
  }
}
