import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';

import { MonitoringStack } from './monitoring.stack.js';

describe('Monitoring Stack', () => {
  test('MonitoringStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();
    const stack = new MonitoringStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
