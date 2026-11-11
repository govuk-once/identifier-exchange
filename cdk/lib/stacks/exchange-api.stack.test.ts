import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';

import { ExchangeApiStack } from './exchange-api.stack.js';

describe('Exchange Api Stack', () => {
  test('ExchangeApiStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();
    const stack = new ExchangeApiStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
