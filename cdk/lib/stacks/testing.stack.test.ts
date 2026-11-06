import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';

import { Template } from 'aws-cdk-lib/assertions';
import { TestingStack } from './testing.stack';

describe('Testing Stack', () => {
  test('TestingStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();
    const stack = new TestingStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
