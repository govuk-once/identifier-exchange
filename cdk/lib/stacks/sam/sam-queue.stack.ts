import { Duration, Stack } from 'aws-cdk-lib';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import type { Construct } from 'constructs';

export class SAMQueueStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const queue = new Queue(this, 'WorkQueue', {
      visibilityTimeout: Duration.seconds(30),
    });

    const producer = new Function(this, 'ProducerFunction', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'producer.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
      environment: {
        QUEUE_URL: queue.queueUrl,
      },
    });

    producer.node.addMetadata('sam:source-entry', 'src/sam/queue-producer.handler.ts');

    queue.grantSendMessages(producer);

    const consumer = new Function(this, 'ConsumerFunction', {
      runtime: Runtime.NODEJS_24_X,
      handler: 'consumer.handler',
      code: Code.fromInline('exports.handler = async () => ({})'),
    });

    consumer.node.addMetadata('sam:source-entry', 'src/sam/queue-consumer.handler.ts');

    consumer.addEventSource(new SqsEventSource(queue, { batchSize: 10 }));

    const api = new RestApi(this, 'WorkApi');
    const messages = api.root.addResource('messages');

    messages.addMethod('POST', new LambdaIntegration(producer));
  }
}
