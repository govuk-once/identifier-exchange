import type { Template } from 'aws-cdk-lib/assertions';
import { expect } from 'vitest';
import { GDSEnv } from '@govuk-connect/dev';
import { MAX_AZS } from '../stacks/network-security.stack';

export const TEST_ENV = { account: '123456789012', region: 'eu-west-2' };

/**
 * SSM path prefix of the shared network stack in a development synth, built
 * the same way as ContextHelper's `sharedPrefix` so it follows the environment
 * naming rather than hardcoding it.
 */
export const SHARED_SSM_PREFIX = `/${GDSEnv.DEVELOPMENT}-identifier-exchange`;

/** Ref to the CloudFormation parameter that reads an SSM parameter. */
export const ssmRef = (template: Template, parameterName: string) => {
  const [id] = Object.keys(
    template.findParameters('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: parameterName,
    }),
  );
  expect(id, `no SSM lookup for ${parameterName}`).toBeDefined();
  return { Ref: id };
};

/** The shared VPC's ID, as importSharedVpc resolves it. */
export const sharedVpcId = (template: Template) =>
  ssmRef(template, `${SHARED_SSM_PREFIX}/network/vpc-id`);

/** The shared VPC's isolated subnet IDs, as importSharedVpc resolves them. */
export const sharedSubnetIds = (template: Template) => {
  const list = ssmRef(template, `${SHARED_SSM_PREFIX}/network/isolated-subnet-ids`);
  return Array.from({ length: MAX_AZS }, (_, i) => ({
    'Fn::Select': [i, { 'Fn::Split': [',', list] }],
  }));
};
