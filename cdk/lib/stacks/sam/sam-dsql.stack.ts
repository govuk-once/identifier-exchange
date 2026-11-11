import { Stack } from 'aws-cdk-lib';
import { CfnCluster } from 'aws-cdk-lib/aws-dsql';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

export class SAMDSQLStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Provision Aurora DSQL Cluster
    const dsqlCluster = new CfnCluster(this, 'MainDsqlCluster', {
      deletionProtectionEnabled: false,
    });

    // Encrypts the item's `secret` field before it is written.
    const key = new Key(this, 'DSQLItemsKey', { enableKeyRotation: true });

    const fn = new Function(this, 'DSQLItemsFunction', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'dsql.handler.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
      environment: {
        DSQL_CLUSTER_ENDPOINT: `${dsqlCluster.attrIdentifier}.dsql.${this.region}.on.aws`,
        KMS_KEY_ID: key.keyId,
      },
    });

    fn.node.addMetadata('sam:source-entry', 'src/sam/dsql.handler.ts');
    // Applied to the local DSQL emulator by `dev sam:start`. TEXT rather than JSONB:
    // DSQL does not store json/jsonb columns.
    fn.node.addMetadata(
      'sam:dsql-schema',
      'CREATE TABLE IF NOT EXISTS items (id VARCHAR(255) PRIMARY KEY, data TEXT NOT NULL, secret_ciphertext TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);',
    );

    key.grantEncryptDecrypt(fn);

    // Grant IAM permissions to connect to DSQL cluster
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['dsql:DbConnect', 'dsql:DbConnectAdmin'],
        resources: [
          `arn:aws:dsql:${this.region}:${this.account}:cluster/${dsqlCluster.attrIdentifier}`,
        ],
      }),
    );

    const api = new RestApi(this, 'DSQLItemsApi');
    const items = api.root.addResource('dsql-items');
    const item = items.addResource('{id}');

    const integration = new LambdaIntegration(fn);
    items.addMethod('GET', integration);
    items.addMethod('POST', integration);
    item.addMethod('GET', integration);
  }
}
