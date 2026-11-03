import * as cdk from 'aws-cdk-lib';
// import { GovUKTag } from '@govuk-connect/govuk-tag';
import type { Construct } from 'constructs';
import { ContextHelper } from '../utils/context-helper';

export class PerformanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    if (ContextHelper.get(this, 'isNotProd')) {
      return;
    }
  }
}
