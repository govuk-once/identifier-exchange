import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GDSEnv } from '@govuk-connect/dev';
import { describe, expect, test } from 'vitest';
import { STANDARD_GATEWAY_RESPONSES } from '../api/gateway-responses.js';
import { TEST_ENV, sharedSubnetIds, sharedVpcId, ssmRef } from '../testing/helpers.js';
import { deleteThingRoute, fixtureRoutes, getThingRoute } from '../testing/routes.js';
import { ContextHelper } from '../utils/context-helper.js';
import { ExchangeApiStack, type ExchangeApiStackProps } from './exchange-api.stack.js';

// Fixture routes, so these tests do not depend on the API's (example) routes.
const synth = (props: Omit<ExchangeApiStackProps, 'env'> = {}, developerId?: string) => {
  // Skip esbuild bundling: these tests assert on the template, not the bundle.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  ContextHelper.setAll(app, {
    environment: GDSEnv.DEVELOPMENT,
    appName: 'identifier-exchange',
    developerId,
  });
  const stack = new ExchangeApiStack(app, 'TestExchangeApiStack', {
    env: TEST_ENV,
    routes: fixtureRoutes,
    ...props,
  });
  return { app, stack, template: Template.fromStack(stack) };
};

const PREFIX = '/development-identifier-exchange';
const CLUSTER_ENDPOINT = `${PREFIX}/dsql/cluster-endpoint`;
const CLIENT_SG = `${PREFIX}/dsql/client-security-group-id`;
const READ_ONLY_ROLE = `${PREFIX}/dsql/read-only-role-arn`;
const READ_WRITE_ROLE = `${PREFIX}/dsql/read-write-role-arn`;
const DELETE_ROLE = `${PREFIX}/dsql/delete-role-arn`;
const DATA_KEY = `${PREFIX}/kms/data-encryption-key-arn`;
const EXECUTE_API_ENDPOINT = `${PREFIX}/network/execute-api-endpoint-id`;

const findFunction = (template: Template, name: string) => {
  const [entry] = Object.entries(
    template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: `development-identifier-exchange-api-${name}` },
    }),
  );
  expect(entry, `no function ${name}`).toBeDefined();
  return { id: entry![0], properties: entry![1]['Properties'] };
};
const getThingFunction = (template: Template) => findFunction(template, 'get-thing').properties;

describe('Exchange Api Stack', () => {
  test('reads upstream stack outputs from SSM, not lookups or exports', () => {
    const { app, template } = synth();

    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
    for (const name of [
      CLUSTER_ENDPOINT,
      CLIENT_SG,
      READ_ONLY_ROLE,
      READ_WRITE_ROLE,
      DATA_KEY,
      EXECUTE_API_ENDPOINT,
    ]) {
      ssmRef(template, name);
    }
    sharedVpcId(template);
    expect(app.synth().manifest.missing ?? []).toEqual([]);
  });

  test('creates a private REST API on the shared execute-api endpoint, with a v1 stage', () => {
    const { template } = synth();

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'development-identifier-exchange-exchange-api',
      EndpointConfiguration: {
        Types: ['PRIVATE'],
        VpcEndpointIds: [ssmRef(template, EXECUTE_API_ENDPOINT)],
      },
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'v1' });
    template.hasOutput('ExchangeApiUrl', {});
  });

  test('resource policy refuses requests from outside the allowed VPC endpoints', () => {
    const { template } = synth();
    const endpoint = [ssmRef(template, EXECUTE_API_ENDPOINT)];

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Policy: {
        Statement: [
          {
            Sid: 'DenyOutsideAllowedVpcEndpoints',
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Action: 'execute-api:Invoke',
            Resource: 'execute-api:/*',
            Condition: { StringNotEquals: { 'aws:SourceVpce': endpoint } },
          },
          {
            Sid: 'AllowSignedRequestsFromAllowedAccounts',
            Effect: 'Allow',
            Principal: { AWS: Match.objectLike({ 'Fn::Join': Match.anyValue() }) },
            Action: 'execute-api:Invoke',
            Resource: 'execute-api:/*',
            Condition: { StringEquals: { 'aws:SourceVpce': endpoint } },
          },
        ],
      },
    });
  });

  test('consumer endpoints and invoker accounts can be allowed explicitly', () => {
    const { template } = synth({
      consumerVpcEndpointIds: ['vpce-0consumer'],
      invokerAccountIds: ['210987654321'],
    });
    const endpoints = [ssmRef(template, EXECUTE_API_ENDPOINT), 'vpce-0consumer'];

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Policy: {
        Statement: [
          Match.objectLike({ Condition: { StringNotEquals: { 'aws:SourceVpce': endpoints } } }),
          Match.objectLike({
            Principal: {
              AWS: [
                Match.anyValue(),
                { 'Fn::Join': ['', Match.arrayWith([':iam::210987654321:root'])] },
              ],
            },
            Condition: { StringEquals: { 'aws:SourceVpce': endpoints } },
          }),
        ],
      },
    });
  });

  test('requires SigV4 on every method', () => {
    const { template } = synth();

    for (const method of Object.values(template.findResources('AWS::ApiGateway::Method'))) {
      expect(method['Properties'].AuthorizationType).toBe('AWS_IAM');
    }
  });

  test('refuses to synthesize an API with no routes', () => {
    expect(() => synth({ routes: [] })).toThrow('needs at least one route');
  });

  test('an isolated (PR) deployment names everything with the developer ID', () => {
    const { template } = synth({}, 'pr-123');

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'pr-123-identifier-exchange-exchange-api',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'pr-123-identifier-exchange-api-get-thing',
    });
    ssmRef(template, '/pr-123-identifier-exchange/dsql/read-only-role-arn');
    // The shared network stack's outputs keep the environment prefix.
    ssmRef(template, DATA_KEY);
  });

  test('runs route handlers in the isolated subnets as the route database role', () => {
    const { template } = synth();
    const fn = getThingFunction(template);

    expect(fn).toMatchObject({
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      VpcConfig: {
        SecurityGroupIds: [ssmRef(template, CLIENT_SG)],
        SubnetIds: sharedSubnetIds(template),
      },
      Environment: {
        Variables: {
          CLUSTER_ENDPOINT: ssmRef(template, CLUSTER_ENDPOINT),
          DATA_ENCRYPTION_KEY_ARN: ssmRef(template, DATA_KEY),
        },
      },
    });
    // getThing is read-only; the role is DataMigratorStack's, not a new one.
    expect(JSON.stringify(fn.Role)).toContain(ssmRef(template, READ_ONLY_ROLE).Ref);
    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::IAM::Policy', 0);
  });

  test('logs JSON to a log group with retention, created with the stack', () => {
    const { template } = synth();
    const fn = getThingFunction(template);
    const [logGroupId, logGroup] = Object.entries(
      template.findResources('AWS::Logs::LogGroup', {
        Properties: { LogGroupName: '/aws/lambda/development-identifier-exchange-api-get-thing' },
      }),
    )[0]!;

    expect(logGroup['Properties'].RetentionInDays).toBe(90);
    expect(logGroup['DeletionPolicy']).toBe('Delete');
    expect(fn.LoggingConfig).toEqual({
      LogFormat: 'JSON',
      LogGroup: { Ref: logGroupId },
      ApplicationLogLevel: 'DEBUG',
      SystemLogLevel: 'WARN',
    });
  });

  test('in production, logs at INFO and keeps log groups when the stack is deleted', () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    ContextHelper.setAll(app, { environment: GDSEnv.PRODUCTION, appName: 'identifier-exchange' });
    const template = Template.fromStack(
      new ExchangeApiStack(app, 'ProdExchangeApiStack', { env: TEST_ENV, routes: fixtureRoutes }),
    );

    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({ ApplicationLogLevel: 'INFO' }),
    });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
  });

  test('a read-write route runs as the read-write role', () => {
    const { template } = synth();

    expect(JSON.stringify(findFunction(template, 'create-thing').properties.Role)).toContain(
      ssmRef(template, READ_WRITE_ROLE).Ref,
    );
  });

  test('a delete route runs as the delete role', () => {
    const { template } = synth({ routes: [...fixtureRoutes, deleteThingRoute] });

    const role = JSON.stringify(findFunction(template, 'delete-thing').properties.Role);
    expect(role).toContain(ssmRef(template, DELETE_ROLE).Ref);
    expect(role).not.toContain(ssmRef(template, READ_WRITE_ROLE).Ref);
  });

  test('binds each route handler to its method, with edge validation', () => {
    const { template } = synth();
    const { id: functionId } = findFunction(template, 'get-thing');

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'AWS_IAM',
      RequestValidatorId: Match.anyValue(),
      RequestParameters: { 'method.request.path.id': true },
      Integration: {
        Type: 'AWS_PROXY',
        Uri: Match.objectLike({
          'Fn::Join': ['', Match.arrayWith([{ 'Fn::GetAtt': [functionId, 'Arn'] }])],
        }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      FunctionName: { 'Fn::GetAtt': [functionId, 'Arn'] },
      Principal: 'apigateway.amazonaws.com',
    });
  });

  test('rejects duplicate operation IDs', () => {
    expect(() => synth({ routes: [getThingRoute, getThingRoute] })).toThrow(
      'Duplicate route operationId: getThing',
    );
  });

  describe('gateway responses', () => {
    test.each([
      ['BAD_REQUEST_BODY', '400', 'BAD_REQUEST'],
      ['BAD_REQUEST_PARAMETERS', '400', 'BAD_REQUEST'],
      ['UNAUTHORIZED', '401', 'UNAUTHORIZED'],
      ['ACCESS_DENIED', '403', 'FORBIDDEN'],
      ['MISSING_AUTHENTICATION_TOKEN', '403', 'FORBIDDEN'],
      ['INVALID_SIGNATURE', '403', 'FORBIDDEN'],
      ['INTEGRATION_FAILURE', '502', 'BAD_GATEWAY'],
      ['INTEGRATION_TIMEOUT', '504', 'GATEWAY_TIMEOUT'],
    ])('%s returns %s with code %s', (responseType, statusCode, code) => {
      const { template } = synth();

      template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
        ResponseType: responseType,
        StatusCode: statusCode,
        ResponseTemplates: {
          'application/json': Match.stringLikeRegexp(`"code":"${code}"`),
        },
      });
    });

    test.each(['DEFAULT_4XX', 'DEFAULT_5XX'])(
      '%s keeps API Gateway status code (e.g. 429 when throttled)',
      (responseType) => {
        const { template } = synth();

        template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
          ResponseType: responseType,
          StatusCode: Match.absent(),
          ResponseTemplates: { 'application/json': Match.anyValue() },
        });
      },
    );

    test('validation failures include API Gateway validation error', () => {
      const { template } = synth();

      template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
        ResponseType: 'BAD_REQUEST_BODY',
        ResponseTemplates: {
          'application/json': Match.stringLikeRegexp(
            String.raw`"details":\["\$context\.error\.validationErrorString"\]`,
          ),
        },
      });
    });

    test.each(Object.entries(STANDARD_GATEWAY_RESPONSES))(
      '%s template is valid JSON with the API error shape',
      (_id, { template }) => {
        // Substitute the VTL variables the way API Gateway would.
        const rendered = template
          .replaceAll('$context.error.messageString', '"Forbidden"')
          .replaceAll('$context.error.validationErrorString', 'Invalid request body')
          .replaceAll('$context.requestId', 'request-1');
        expect(JSON.parse(rendered)).toEqual({
          code: expect.any(String),
          message: expect.any(String),
          requestId: 'request-1',
          ...(rendered.includes('details') && { details: ['Invalid request body'] }),
        });
      },
    );
  });
});
