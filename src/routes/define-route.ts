import type { z } from 'zod';

// Route definitions are plain data with no CDK imports, so a handler can
// import its route's Zod schemas and validate with exactly what API Gateway
// was configured with. cdk/lib/api/create-route.ts turns them into API
// Gateway models, request validators and methods.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Path, query and header parameters are flat string maps, so their schemas are objects. */
export type ParameterSchema = z.ZodObject;

export interface ResponseDefinition {
  description: string;
  /** Documents the response body; becomes an API Gateway model. */
  schema?: z.ZodType;
}

export interface RouteDefinition {
  /** Unique, PascalCase-able name, e.g. `getItem`. Model names derive from it. */
  operationId: string;
  method: HttpMethod;
  /** API Gateway path; `{name}` segments must match keys of `request.params`. */
  path: string;
  summary: string;
  handler: {
    /** Lambda entry point, relative to the repository root. */
    entry: string;
    /**
     * Which DataMigratorStack workload role the function runs as. Only
     * 'delete' (delete_role) can DELETE from linked_identifiers and
     * identifier_attributes; 'readwrite' cannot.
     */
    databaseAccess: 'readonly' | 'readwrite' | 'delete';
  };
  /**
   * Every method requires a SigV4-signed request (IAM authorization), so
   * there is no per-route auth setting.
   *
   * API Gateway rejects a request before invoking Lambda when a required
   * parameter or header is missing, or the body fails its schema. Objects in
   * the body reject unknown keys unless declared with `z.looseObject`. It
   * cannot check the *format* of path, query or header values, so handlers
   * still parse those with these schemas.
   */
  request?: {
    params?: ParameterSchema;
    query?: ParameterSchema;
    /** Header names as clients send them, e.g. `{ 'Idempotency-Key': z.uuid() }`. */
    headers?: ParameterSchema;
    body?: z.ZodType;
  };
  /** Keyed by HTTP status code. */
  responses: Record<number, ResponseDefinition>;
}

/** Identity function that type-checks a route and keeps its literal schema types. */
export const defineRoute = <const R extends RouteDefinition>(route: R): R => route;
