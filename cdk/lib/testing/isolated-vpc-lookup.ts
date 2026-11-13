import * as cdk from 'aws-cdk-lib';
import type { VpcContextResponse, VpcSubnetGroupType } from 'aws-cdk-lib/cx-api';
import { ISOLATED_SUBNET_GROUP, VPC_CIDR } from '../stacks/network-security.stack';
import { ContextProvider } from 'aws-cdk-lib/cloud-assembly-schema';

export const TEST_ENV = { account: '123456789012', region: 'eu-west-2' };

export const LOOKED_UP_VPC_ID = 'vpc-0isolated';
export const LOOKED_UP_SUBNET_IDS = ['subnet-0isolateda', 'subnet-0isolatedb'];

/** What `Vpc.fromLookup` sees once NetworkSecurityStack is deployed. */
const isolatedVpcResponse: VpcContextResponse = {
  vpcId: LOOKED_UP_VPC_ID,
  vpcCidrBlock: VPC_CIDR,
  availabilityZones: [],
  subnetGroups: [
    {
      name: ISOLATED_SUBNET_GROUP,
      type: 'Isolated' as VpcSubnetGroupType,
      subnets: LOOKED_UP_SUBNET_IDS.map((subnetId, i) => ({
        subnetId,
        cidr: `10.0.${i}.0/24`,
        availabilityZone: `eu-west-2${'ab'[i]}`,
        routeTableId: `rtb-0isolated${i}`,
      })),
    },
  ],
};

/**
 * Builds a stack whose `Vpc.fromLookup` resolves to the isolated VPC, instead
 * of CDK's dummy VPC (which only has public and private-with-egress subnets).
 *
 * A throwaway synth reports the exact context key CDK asks for, so the test
 * does not depend on how CDK formats lookup keys.
 */
export const synthWithIsolatedVpc = <S extends cdk.Stack>(
  build: (app: cdk.App) => S,
  appProps: cdk.AppProps = {},
): { app: cdk.App; stack: S } => {
  const probe = new cdk.App(appProps);
  build(probe);
  const vpcLookups = (probe.synth().manifest.missing ?? []).filter(
    (m) => m.provider === ContextProvider.VPC_PROVIDER,
  );

  const app = new cdk.App({
    ...appProps,
    context: {
      ...appProps.context,
      ...Object.fromEntries(vpcLookups.map((m) => [m.key, isolatedVpcResponse])),
    },
  });
  return { app, stack: build(app) };
};
