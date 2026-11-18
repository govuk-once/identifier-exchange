import * as path from 'node:path';
import { routes } from '../../../src/routes/index.js';
import { buildOpenApiSpec, type OpenApiSpec } from './openapi.js';

/** Stage the REST API is deployed to, and the first segment of every URL. */
export const API_STAGE_NAME = 'v1';

/** Committed spec, kept in sync by `pnpm export:openapi` and the pre-commit hook. */
export const OPENAPI_SPEC_PATH = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'openapi.json',
);

/** The OpenAPI document for every route ExchangeApiStack deploys. */
export const exchangeApiSpec = (): OpenApiSpec =>
  buildOpenApiSpec(routes, {
    title: 'Identifier Exchange API',
    version: API_STAGE_NAME,
    description:
      'Generated from src/routes by `pnpm export:openapi`; do not edit by hand. ' +
      'Private API: reachable only through an allowed execute-api VPC endpoint, ' +
      'with SigV4-signed requests. Errors from API Gateway and from handlers share ' +
      'the ApiError shape.',
    stageName: API_STAGE_NAME,
  });
