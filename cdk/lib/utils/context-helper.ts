import type * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { GDSEnv, type GDSEnvironment } from '@govuk-connect/dev';

// 1. Define your strongly-typed context schema
export interface AppContext {
  environment: GDSEnvironment;
  account?: string;
  region?: string;
  appName?: string;
  /**
   * Isolates a deployment, e.g. `pr-123` for a pull request (the
   * DEVELOPER_ID convention shared with user-data-platform). When set, it
   * replaces the prefix on everything except the shared network stack.
   */
  developerId?: string;
}

// 2. Values derived from AppContext rather than stored in it
export interface DerivedContext {
  isProd: boolean;
  isNotProd: boolean;
  /** `pr-123` for an isolated deployment, otherwise `dev-identifier-exchange`. */
  prefix: string;
  /** Always `<environment>-<appName>`: names in the shared NetworkSecurityStack. */
  sharedPrefix: string;
}

// 3. Derived values that need an argument to resolve
export interface DerivedContextFns {
  resourceName: (name: string) => string;
  resourceId: (id?: string) => string | undefined;
}

const RESOURCE_ID_MAX_LENGTH = 40;

function readContext<K extends keyof AppContext>(
  scope: Construct,
  key: K,
  required: boolean = true,
): AppContext[K] | undefined {
  const value = scope.node.tryGetContext(key) as AppContext[K] | undefined;

  if (required && (value === undefined || value === null)) {
    throw new Error(`Missing required CDK context key: "${key}"`);
  }

  return value;
}

/**
 * Short enough that `<id>-<appName>-dsql-readwrite` (the longest name, an IAM
 * role) stays inside IAM's 64-character limit.
 */
const DEVELOPER_ID = /^[a-z0-9][a-z0-9-]{0,19}$/;

const getSharedPrefix = (scope: Construct): string => {
  const environment = readContext(scope, 'environment', true);
  const appName = readContext(scope, 'appName', true);
  return `${environment}-${appName}`.toLowerCase();
};

const getPrefix = (scope: Construct): string => {
  const developerId = readContext(scope, 'developerId', false);
  if (!developerId) {
    return getSharedPrefix(scope);
  }
  if (!DEVELOPER_ID.test(developerId)) {
    throw new Error(
      `developerId "${developerId}" must be lower-case letters, digits and hyphens (max 20), e.g. pr-123`,
    );
  }
  const appName = readContext(scope, 'appName', true);
  return `${developerId}-${appName}`.toLowerCase();
};

const getResourceName = (scope: Construct, name: string): string => {
  const prefix = getPrefix(scope);
  if (name && !name.startsWith(prefix)) {
    return `${prefix}-${name}`;
  }
  return name;
};

const getResourceId = (scope: Construct, id?: string): string | undefined => {
  const prefix = getPrefix(scope);
  if (id && !id.startsWith(prefix)) {
    return `${prefix}-${id}`.toLowerCase().substring(0, RESOURCE_ID_MAX_LENGTH);
  }
  return id;
};

const isProd = (scope: Construct): boolean =>
  readContext(scope, 'environment', true) === GDSEnv.PRODUCTION;

const derived: { [K in keyof DerivedContext]: (scope: Construct) => DerivedContext[K] } = {
  isProd,
  isNotProd: (scope) => !isProd(scope),
  prefix: getPrefix,
  sharedPrefix: getSharedPrefix,
};

// 4. Create the helper module
export const ContextHelper = {
  /**
   * Sets typed context values globally on the CDK App node.
   */
  setAll(app: cdk.App, config: AppContext): void {
    Object.entries(config).forEach(([key, value]) => {
      if (value !== undefined) {
        app.node.setContext(key, value);
      }
    });
  },

  /**
   * Sets a single context key-value pair on the app node.
   */
  set<K extends keyof AppContext>(app: cdk.App, key: K, value: AppContext[K]): void {
    app.node.setContext(key, value);
  },

  /**
   * Reads a typed context key, or a value derived from context, from any construct scope.
   *
   *   ContextHelper.get(this, 'environment')
   *   ContextHelper.get(this, 'isProd')
   *   ContextHelper.get(this, 'prefix')                  // "dev-identifier-exchange", or "pr-123"
   *   ContextHelper.get(this, 'sharedPrefix')            // always "dev-identifier-exchange"
   *   ContextHelper.get(this, 'resourceName', 'table')   // "dev-identifier-exchange-table"
   *   ContextHelper.get(this, 'resourceId', 'Table')     // lower-cased, max 40 chars
   *
   * Throws an error if a required key is missing.
   */
  get: getContext,
};

function getContext<K extends keyof AppContext>(
  scope: Construct,
  key: K,
  required?: boolean,
): AppContext[K];
function getContext<K extends keyof DerivedContext>(scope: Construct, key: K): DerivedContext[K];
function getContext(scope: Construct, key: 'resourceName', name: string): string;
function getContext(scope: Construct, key: 'resourceId', id?: string): string | undefined;
function getContext(
  scope: Construct,
  key: keyof AppContext | keyof DerivedContext | keyof DerivedContextFns,
  arg?: boolean | string,
): unknown {
  switch (key) {
    case 'resourceName':
      return getResourceName(scope, arg as string);
    case 'resourceId':
      return getResourceId(scope, arg as string | undefined);
    case 'isProd':
    case 'isNotProd':
    case 'prefix':
    case 'sharedPrefix':
      return derived[key](scope);
    default:
      return readContext(scope, key, (arg as boolean | undefined) ?? true);
  }
}
