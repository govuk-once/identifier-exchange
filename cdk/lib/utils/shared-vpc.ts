import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { MAX_AZS } from '../stacks/network-security.stack.js';
import { SharedResources } from './shared-resources.js';

/**
 * The VPC from NetworkSecurityStack, resolved from SSM by CloudFormation at
 * deploy time.
 *
 * Unlike `Vpc.fromLookup`, this needs nothing from the account at synth time,
 * so the whole app synthesizes before NetworkSecurityStack has ever been
 * deployed. `Fn.split` with an assumed length gives CDK a fixed number of
 * subnets/AZs to work with; it must match what NetworkSecurityStack creates.
 */
export const importSharedVpc = (scope: Construct, id = 'SharedVpc'): ec2.IVpc => {
  const read = (parameterName: string) =>
    ssm.StringParameter.valueForStringParameter(scope, parameterName);

  return ec2.Vpc.fromVpcAttributes(scope, id, {
    vpcId: read(SharedResources.vpcIdParameter(scope)),
    availabilityZones: cdk.Fn.split(
      ',',
      read(SharedResources.availabilityZonesParameter(scope)),
      MAX_AZS,
    ),
    isolatedSubnetIds: cdk.Fn.split(
      ',',
      read(SharedResources.isolatedSubnetIdsParameter(scope)),
      MAX_AZS,
    ),
  });
};
