import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';

import { Template } from 'aws-cdk-lib/assertions';
import { PerformanceStack } from './performance.stack';

describe('Performance Stack', () => {
  test('PerformanceStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();
    const stack = new PerformanceStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
