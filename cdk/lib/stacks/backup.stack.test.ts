import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { GDSEnv } from '@govuk-connect/dev';

import { BackupStack } from './backup.stack.js';
import { ContextHelper } from '../utils/context-helper.js';

describe('Backup Stack', () => {
  test('BackupStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();

    ContextHelper.setAll(app, {
      environment: GDSEnv.DEVELOPMENT,
    });

    const stack = new BackupStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
