import type { Construct } from 'constructs';
import { ContextHelper } from './context-helper';

/**
 * Names that stacks publish and downstream stacks look up. Stacks find
 * each other's resources by these names instead of passing constructs across
 * stack boundaries, so there are no CloudFormation exports to lock them
 * together.
 */
export const SharedResources = {
  /** `Name` tag on the shared VPC, used by `ec2.Vpc.fromLookup`. */
  vpcName: (scope: Construct): string => ContextHelper.get(scope, 'resourceName', 'vpc'),

  /** SSM parameter holding the shared KMS key ARN, for `kms.Key.fromKeyArn`. */
  encryptionKeyArnParameter: (scope: Construct): string =>
    `/${ContextHelper.get(scope, 'prefix')}/kms/encryption-key-arn`,

  /** SSM parameters published by DataStack. */
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
