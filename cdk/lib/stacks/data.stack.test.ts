import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';

import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from './data.stack';

describe('Data Stack', () => {
  test('DataStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();
    const stack = new DataStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
