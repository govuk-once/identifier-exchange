import { Stack } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { Key } from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

export class MainStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const table = new Table(this, 'DynamoItemsTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    // Encrypts the item's `secret` field before it is written.
    const key = new Key(this, 'DynamoItemsKey', { enableKeyRotation: true });

    const fn = new Function(this, 'DynamoItemsFunction', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'handler.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
      environment: {
        TABLE_NAME: table.tableName,
        KMS_KEY_ID: key.keyId,
      },
    });

    fn.node.addMetadata('sam:source-entry', 'src/dynamo/dynamo.handler.ts');

    table.grantReadWriteData(fn);
    key.grantEncryptDecrypt(fn);

    const api = new RestApi(this, 'ItemsApi');
    const items = api.root.addResource('dynamo-items');
    const item = items.addResource('{id}');

    const integration = new LambdaIntegration(fn);
    items.addMethod('GET', integration);
    items.addMethod('POST', integration);
    item.addMethod('GET', integration);
  }
}
