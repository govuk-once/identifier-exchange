import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

// 1. Define your strongly-typed context schema
export interface AppContext {
  environment: 'dev' | 'staging' | 'prod';
  region?: string;
  appName?: string;
}

// 2. Create the helper module
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
    app.node.setContext(key as string, value);
  },

  /**
   * Reads a typed context key from any construct scope (e.g., Stack or Construct).
   * Throws an error if a required key is missing.
   */
  get<K extends keyof AppContext>(scope: Construct, key: K, required = true): AppContext[K] {
    const value = scope.node.tryGetContext(key as string) as AppContext[K] | undefined;

    if (required && (value === undefined || value === null)) {
      throw new Error(`Missing required CDK context key: "${String(key)}"`);
    }

    return value!;
  },
};