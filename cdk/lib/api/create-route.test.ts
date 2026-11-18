import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { RouteDefinition } from '../../../src/routes/define-route.js';
import { createThingRoute, getThingRoute, listThingsRoute } from '../testing/routes.js';
import { createRoute, requestParameters, toApiGatewaySchema } from './create-route.js';

const DRAFT_4 = 'http://json-schema.org/draft-04/schema#';

const synth = (...routes: RouteDefinition[]) => {
  const stack = new cdk.Stack(new cdk.App(), 'RouteTestStack');
  const api = new apigateway.RestApi(stack, 'Api');
  const handler = lambda.Function.fromFunctionArn(
    stack,
    'Handler',
    'arn:aws:lambda:eu-west-2:123456789012:function:handler',
  );
  const methods = routes.map((route) => createRoute(api, route, handler));
  return { template: Template.fromStack(stack), methods };
};

describe('toApiGatewaySchema', () => {
  test('compiles a Zod schema to JSON Schema draft 4', () => {
    expect(toApiGatewaySchema(getThingRoute.request.params, 'input')).toEqual({
      $schema: DRAFT_4,
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid', pattern: expect.any(String) } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  test('keeps optional fields out of `required`', () => {
    expect(toApiGatewaySchema(createThingRoute.request.body, 'input')).toMatchObject({
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
    });
  });

  test('closes request objects, at every level, so unknown keys are rejected', () => {
    const schema = toApiGatewaySchema(createThingRoute.request.body, 'input');

    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: { attributes: { additionalProperties: false } },
    });
  });

  test('leaves z.looseObject and records open', () => {
    const schema = toApiGatewaySchema(createThingRoute.request.body, 'input');
    const record = toApiGatewaySchema(z.record(z.string(), z.number()), 'input');

    expect(schema.properties?.['labels']?.additionalProperties).toEqual({});
    expect(record.additionalProperties).toEqual({ type: 'number' });
  });

  test('refuses types JSON Schema cannot express, at synth time', () => {
    expect(() => toApiGatewaySchema(z.date(), 'input')).toThrow();
  });
});

describe('requestParameters', () => {
  test('requires path parameters, and query parameters and headers unless optional', () => {
    expect(requestParameters(getThingRoute)).toEqual({
      'method.request.path.id': true,
      'method.request.querystring.expand': false,
      'method.request.header.X-Correlation-Id': false,
    });
    expect(requestParameters(createThingRoute)).toEqual({
      'method.request.header.Idempotency-Key': true,
    });
  });
});

describe('createRoute', () => {
  test('binds the handler to the resource path with a Lambda proxy integration', () => {
    const { template } = synth(getThingRoute);

    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'things' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{id}' });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      OperationName: 'getThing',
      ResourceId: { Ref: Match.stringLikeRegexp('thingsid') },
      Integration: {
        Type: 'AWS_PROXY',
        IntegrationHttpMethod: 'POST',
        Uri: Match.objectLike({
          'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('function:handler')])],
        }),
      },
    });
  });

  test('requires SigV4 (IAM authorization) on every method', () => {
    const { template } = synth(getThingRoute, createThingRoute, listThingsRoute);

    for (const method of Object.values(template.findResources('AWS::ApiGateway::Method'))) {
      expect(method['Properties'].AuthorizationType).toBe('AWS_IAM');
    }
  });

  test('validates required parameters and headers at the edge', () => {
    const { template } = synth(getThingRoute);

    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      ValidateRequestBody: false,
      ValidateRequestParameters: true,
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      RequestValidatorId: { Ref: Match.stringLikeRegexp('ValidateParameters') },
      RequestParameters: requestParameters(getThingRoute),
    });
  });

  test('validates the body against its model whatever the Content-Type', () => {
    const { template } = synth(createThingRoute);
    const model = { Ref: Match.stringLikeRegexp('CreateThingRequest') };

    template.hasResourceProperties('AWS::ApiGateway::Model', {
      Name: 'CreateThingRequest',
      ContentType: 'application/json',
      Schema: Match.objectLike({ $schema: DRAFT_4, required: ['name'] }),
    });
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      ValidateRequestBody: true,
      ValidateRequestParameters: true,
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      RequestModels: { 'application/json': model, $default: model },
      RequestValidatorId: { Ref: Match.stringLikeRegexp('ValidateBodyAndParameters') },
    });
  });

  test('maps every response status, with a model where a schema is given', () => {
    const { template } = synth(getThingRoute, createThingRoute);

    for (const status of ['200', '404']) {
      template.hasResourceProperties('AWS::ApiGateway::Model', {
        Name: `GetThingResponse${status}`,
        Schema: Match.objectLike({ $schema: DRAFT_4, type: 'object' }),
      });
    }
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      MethodResponses: Match.arrayWith([
        {
          StatusCode: '404',
          ResponseModels: {
            'application/json': { Ref: Match.stringLikeRegexp('GetThingResponse404') },
          },
        },
      ]),
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      MethodResponses: [{ StatusCode: '201' }],
    });
  });

  test('shares one validator per combination of checks across methods', () => {
    const { template } = synth(getThingRoute, {
      ...getThingRoute,
      operationId: 'deleteThing',
      method: 'DELETE',
    });

    template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);
    template.resourceCountIs('AWS::ApiGateway::Method', 2);
  });

  test('a route without parameters or body gets no validator', () => {
    const { template } = synth(listThingsRoute);

    template.resourceCountIs('AWS::ApiGateway::RequestValidator', 0);
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      RequestValidatorId: Match.absent(),
      RequestModels: Match.absent(),
    });
  });

  test('fails synth when the path and params schema disagree', () => {
    expect(() => synth({ ...getThingRoute, path: '/things/{thingId}' })).toThrow(
      'path /things/{thingId} has parameters [thingId] but request.params declares [id]',
    );
  });
});
