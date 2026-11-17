import type { z } from 'zod';
import type { ParameterSchema, RouteDefinition } from '../../../src/routes/define-route.js';
import { toJsonSchema } from './json-schema.js';

const JSON_CONTENT_TYPE = 'application/json';
const SIGV4 = 'sigv4';

/** The subset of an OpenAPI 3.0 document this generator produces. */
export interface OpenApiSpec {
  openapi: '3.0.3';
  info: { title: string; version: string; description?: string };
  servers: { url: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  security: Record<string, string[]>[];
  components: { securitySchemes: Record<string, unknown> };
}

export interface OpenApiOptions {
  title: string;
  version: string;
  description?: string;
  /** Stage path the API is served under, e.g. `v1`. */
  stageName: string;
}

/** A Zod schema as an OpenAPI 3.0 Schema Object. */
export const toOpenApiSchema = (schema: z.ZodType, io: 'input' | 'output') =>
  toJsonSchema(schema, 'openapi-3.0', io);

const parameters = (location: 'path' | 'query' | 'header', schema: ParameterSchema | undefined) =>
  Object.entries(schema?.shape ?? {}).map(([name, field]) => {
    const fieldSchema = field as z.ZodType;
    return {
      name,
      in: location,
      // Path parameters are always required in OpenAPI.
      required: location === 'path' || !fieldSchema.isOptional(),
      schema: toOpenApiSchema(fieldSchema, 'input'),
      ...(fieldSchema.description && { description: fieldSchema.description }),
    };
  });

const operation = (route: RouteDefinition) => {
  const body = route.request?.body;
  const params = [
    ...parameters('path', route.request?.params),
    ...parameters('query', route.request?.query),
    ...parameters('header', route.request?.headers),
  ];
  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(params.length > 0 && { parameters: params }),
    ...(body && {
      requestBody: {
        required: !body.isOptional(),
        content: { [JSON_CONTENT_TYPE]: { schema: toOpenApiSchema(body, 'input') } },
      },
    }),
    responses: Object.fromEntries(
      Object.entries(route.responses).map(([status, { description, schema }]) => [
        status,
        {
          description,
          ...(schema && {
            content: { [JSON_CONTENT_TYPE]: { schema: toOpenApiSchema(schema, 'output') } },
          }),
        },
      ]),
    ),
  };
};

/**
 * OpenAPI 3.0 document for the routes ExchangeApiStack deploys, built from the
 * same route definitions (and Zod schemas) that createRoute turns into API
 * Gateway models and validators, so the two cannot drift.
 *
 * Paths and methods are sorted, so the output only changes when a route does.
 */
export const buildOpenApiSpec = (
  routes: readonly RouteDefinition[],
  options: OpenApiOptions,
): OpenApiSpec => {
  const paths: OpenApiSpec['paths'] = {};
  for (const route of [...routes].sort((a, b) => a.path.localeCompare(b.path))) {
    const methods = (paths[route.path] ??= {});
    const method = route.method.toLowerCase();
    if (methods[method]) {
      throw new Error(`Duplicate route: ${route.method} ${route.path}`);
    }
    methods[method] = operation(route);
  }
  for (const [pathName, methods] of Object.entries(paths)) {
    paths[pathName] = Object.fromEntries(
      Object.entries(methods).sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  return {
    openapi: '3.0.3',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description && { description: options.description }),
    },
    servers: [
      {
        url: `/${options.stageName}`,
        description: 'Relative to the private API URL (ExchangeApiUrl stack output)',
      },
    ],
    paths,
    // Every operation requires SigV4.
    security: [{ [SIGV4]: [] }],
    components: {
      securitySchemes: {
        [SIGV4]: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
          description: 'AWS Signature Version 4, for principals allowed execute-api:Invoke',
          'x-amazon-apigateway-authtype': 'awsSigv4',
        },
      },
    },
  };
};

/** Stable text form written to docs/openapi.json. */
export const serialiseOpenApiSpec = (spec: OpenApiSpec): string =>
  `${JSON.stringify(spec, null, 2)}\n`;
