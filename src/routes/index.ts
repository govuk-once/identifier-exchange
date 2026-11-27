import type { RouteDefinition } from './define-route.js';
import { getItemRoute } from './get-item.route.js';
import { unlinkIdentifierRoute } from './unlink-identifier.route.js';

/**
 * Every route ExchangeApiStack exposes. Add new routes here.
 *
 * `getItemRoute` is an example of the pattern, not part of the API contract.
 * Remove it once a real route exists (API Gateway cannot deploy an API with no
 * methods):
 *   1. delete src/routes/get-item.route.ts and src/handlers/get-item.handler*.ts
 *   2. drop it from this list
 *   3. pnpm export:openapi
 * Nothing else depends on it; the CDK tests use their own fixture routes.
 */
export const routes: readonly RouteDefinition[] = [getItemRoute, unlinkIdentifierRoute];
