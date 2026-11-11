import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { ContextHelper } from '../utils/context-helper.js';

export class BackupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    if (ContextHelper.get(this, 'isNotProd')) {
      return;
    }
  }
}
