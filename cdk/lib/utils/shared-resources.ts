import type { Construct } from 'constructs';
import { ContextHelper } from './context-helper.js';

/**
 * Names that stacks publish and downstream stacks look up. Stacks find
 * each other's resources by these names instead of passing constructs across
 * stack boundaries, so there are no CloudFormation exports to lock them
 * together.
 *
 * NetworkSecurityStack is shared by every deployment in an environment, so
 * its outputs use `sharedPrefix`. Everything else uses `prefix`, which is the
 * developer ID (e.g. `pr-123`) for an isolated deployment.
 */
export const SharedResources = {
  /** `Name` tag on the shared VPC. */
  vpcName: (scope: Construct): string => `${ContextHelper.get(scope, 'sharedPrefix')}-vpc`,

  // SSM parameters describing the shared VPC, read by `importSharedVpc`.
  vpcIdParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/network/vpc-id`,
  /** Comma-separated, one per AZ, in the same order as the AZ parameter. */
  isolatedSubnetIdsParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/network/isolated-subnet-ids`,
  availabilityZonesParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/network/availability-zones`,

  // SSM parameters published by NetworkSecurityStack.
  /** Security group on the shared DSQL endpoint; clients allow egress to it. */
  dsqlEndpointSecurityGroupIdParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/dsql/endpoint-security-group-id`,
  /** For `kms.Key.fromKeyArn`: encrypts the DSQL cluster at rest. */
  dsqlEncryptionKeyArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/kms/dsql-encryption-key-arn`,
  /** For `kms.Key.fromKeyArn`: application-level field encryption. */
  dataEncryptionKeyArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/kms/data-encryption-key-arn`,
  /** For `lambda.CodeSigningConfig.fromCodeSigningConfigArn`. */
  codeSigningConfigArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/code-signing/config-arn`,
  /** Signer profile the deployment pipeline signs Lambda packages with. */
  signingProfileNameParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'sharedPrefix')}/code-signing/signing-profile-name`,

  /** SSM parameters published by DataStack. */
  /** PrivateLink hostname of the cluster; the public endpoint is unreachable from the VPC. */
  dsqlClusterEndpointParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/dsql/cluster-endpoint`,
  dsqlClusterArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/dsql/cluster-arn`,
  /** Security group a workload attaches to reach the DSQL VPC endpoint. */
  dsqlClientSecurityGroupIdParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/dsql/client-security-group-id`,

  /** SSM parameters published by DataMigratorStack. */
  dsqlReadOnlyRoleArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/dsql/read-only-role-arn`,
  dsqlReadWriteRoleArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/dsql/read-write-role-arn`,
  migratorFunctionNameParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/data-migrator/function-name`,
};
