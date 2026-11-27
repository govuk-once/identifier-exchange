import type { RouteDefinition } from './define-route.js';
import { linkIdentifierRoute } from './link-identifier/link-identifier.route.js';

/**
 * Every route ExchangeApiStack exposes. Add new routes here.
 * */
export const routes: readonly RouteDefinition[] = [linkIdentifierRoute];
