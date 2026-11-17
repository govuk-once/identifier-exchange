import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { z } from 'zod';
import type { ParameterSchema, RouteDefinition } from '../../../src/routes/define-route.js';
import { toJsonSchema } from './json-schema.js';

const JSON_CONTENT_TYPE = 'application/json';
/**
 * API Gateway picks a request model by the request's Content-Type, and
 * validates nothing when none matches. Mapping the body model to `$default`
 * as well means a body sent as text/plain (or with no Content-Type) is still
 * validated.
 */
const ANY_CONTENT_TYPE = '$default';

/** A Zod schema as the JSON Schema draft 4 that API Gateway models use. */
export const toApiGatewaySchema = (
  schema: z.ZodType,
  io: 'input' | 'output',
): apigateway.JsonSchema => toJsonSchema(schema, 'draft-4', io) as apigateway.JsonSchema;

/** `getItem` -> `GetItem`. Model names must be alphanumeric. */
const modelPrefix = (operationId: string) => {
  const name = operationId.replace(/[^A-Za-z0-9]/g, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/** `{id}` / `{proxy+}` segments of an API Gateway path. */
const pathParameterNames = (path: string) =>
  [...path.matchAll(/\{([^}+]+)\+?\}/g)].map(([, name]) => name!);

/**
 * `method.request.<location>.<name>: required` for API Gateway. Path
 * parameters are always required; query parameters and headers are required
 * unless their schema is optional.
 */
export const requestParameters = (route: RouteDefinition): Record<string, boolean> => {
  const fromSchema = (
    location: 'path' | 'querystring' | 'header',
    schema: ParameterSchema | undefined,
  ) =>
    Object.entries(schema?.shape ?? {}).map(([name, field]) => [
      `method.request.${location}.${name}`,
      location === 'path' || !(field as z.ZodType).isOptional(),
    ]);
  return Object.fromEntries([
    ...fromSchema('path', route.request?.params),
    ...fromSchema('querystring', route.request?.query),
    ...fromSchema('header', route.request?.headers),
  ]);
};

/** Fails synth when the path template and the params schema disagree. */
const assertPathParametersMatch = (route: RouteDefinition) => {
  const inPath = pathParameterNames(route.path).toSorted();
  const inSchema = Object.keys(route.request?.params?.shape ?? {}).toSorted();
  if (inPath.join() !== inSchema.join()) {
    throw new Error(
      `Route ${route.operationId}: path ${route.path} has parameters [${inPath.join(', ')}] ` +
        `but request.params declares [${inSchema.join(', ')}]`,
    );
  }
};

/**
 * One validator per combination of checks, shared by every method on an API
 * (API Gateway does not need one per method).
 */
const validators = new WeakMap<apigateway.RestApi, Map<string, apigateway.RequestValidator>>();
const requestValidator = (
  api: apigateway.RestApi,
  validateRequestBody: boolean,
  validateRequestParameters: boolean,
): apigateway.RequestValidator | undefined => {
  if (!validateRequestBody && !validateRequestParameters) {
    return undefined;
  }
  const name = [validateRequestBody && 'Body', validateRequestParameters && 'Parameters']
    .filter(Boolean)
    .join('And');
  const forApi = validators.get(api) ?? new Map<string, apigateway.RequestValidator>();
  validators.set(api, forApi);
  let validator = forApi.get(name);
  if (!validator) {
    validator = api.addRequestValidator(`Validate${name}`, {
      requestValidatorName: `validate-${name.toLowerCase()}`,
      validateRequestBody,
      validateRequestParameters,
    });
    forApi.set(name, validator);
  }
  return validator;
};

/**
 * Adds a route to a REST API:
 *
 * - creates the resource path (`/items/{id}`) if it does not exist yet;
 * - registers the request body schema as an API Gateway model, and response
 *   schemas as models on the method responses;
 * - attaches a request validator, so API Gateway rejects a missing required
 *   parameter or header, or a body that fails its schema (whatever its
 *   Content-Type), before invoking Lambda;
 * - requires SigV4 (IAM authorization) on the method;
 * - binds the handler with a Lambda proxy integration.
 *
 * API Gateway checks that required parameters and headers are present but not
 * their format, so handlers must still parse them with the route's schemas.
 */
export const createRoute = (
  api: apigateway.RestApi,
  route: RouteDefinition,
  handler: lambda.IFunction,
): apigateway.Method => {
  assertPathParametersMatch(route);
  const prefix = modelPrefix(route.operationId);

  const body = route.request?.body;
  const requestModel =
    body &&
    api.addModel(`${prefix}RequestModel`, {
      modelName: `${prefix}Request`,
      contentType: JSON_CONTENT_TYPE,
      schema: toApiGatewaySchema(body, 'input'),
    });

  const parameters = requestParameters(route);
  const validateParameters = Object.values(parameters).some(Boolean);

  const methodResponses = Object.entries(route.responses).map(
    ([statusCode, { schema }]): apigateway.MethodResponse => ({
      statusCode,
      ...(schema && {
        responseModels: {
          [JSON_CONTENT_TYPE]: api.addModel(`${prefix}Response${statusCode}Model`, {
            modelName: `${prefix}Response${statusCode}`,
            contentType: JSON_CONTENT_TYPE,
            schema: toApiGatewaySchema(schema, 'output'),
          }),
        },
      }),
    }),
  );

  const validator = requestValidator(api, !!requestModel, validateParameters);
  return api.root
    .resourceForPath(route.path)
    .addMethod(route.method, new apigateway.LambdaIntegration(handler, { proxy: true }), {
      operationName: route.operationId,
      authorizationType: apigateway.AuthorizationType.IAM,
      requestParameters: parameters,
      methodResponses,
      ...(validator && { requestValidator: validator }),
      ...(requestModel && {
        requestModels: { [JSON_CONTENT_TYPE]: requestModel, [ANY_CONTENT_TYPE]: requestModel },
      }),
    });
};
