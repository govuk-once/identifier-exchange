import { Stack } from 'aws-cdk-lib';

/**
 * Root stack for identifier-exchange.
 *
 * Add constructs in the constructor, for example:
 *
 *   import { Queue } from 'aws-cdk-lib/aws-sqs';
 *   import { Duration } from 'aws-cdk-lib';
 *
 *   new Queue(this, 'Work', { visibilityTimeout: Duration.seconds(300) });
 *
 * Import from the service-specific entry points (`aws-cdk-lib/aws-sqs`) rather
 * than the package root - the root pulls in every service.
 */
export class MainStack extends Stack {}
