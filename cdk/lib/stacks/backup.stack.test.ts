import * as cdk from 'aws-cdk-lib';
import { describe, test } from 'vitest';

import { Template } from 'aws-cdk-lib/assertions';
import { BackupStack } from './backup.stack';
import { ContextHelper } from '../utils/context-helper';
import { GovUkOnceEnvironments } from '../constants/environment';

describe('Backup Stack', () => {
  test('BackupStack synthesizes to a valid empty template', () => {
    const app = new cdk.App();
    ContextHelper.setAll(app, {
      environment: GovUkOnceEnvironments.Dev,
    });
    const stack = new BackupStack(app, 'TestBackupStack');
    const template = Template.fromStack(stack);

    // Verify no resources are defined in placeholder state
    template.templateMatches({});
  });
});
