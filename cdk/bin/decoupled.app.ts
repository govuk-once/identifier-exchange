import * as cdk from 'aws-cdk-lib';
import { ContextHelper } from '../lib/utils/context-helper';
import { BackupStack } from '../lib/stacks/backup.stack';
import { MonitoringStack } from '../lib/stacks/monitoring.stack';
import { PerformanceStack } from '../lib/stacks/performance.stack';
import { GDSEnv } from '@govuk-connect/dev';

const app = new cdk.App();
ContextHelper.setAll(app, {
  environment: GDSEnv.get() || GDSEnv.DEVELOPMENT,
  appName: 'identifier-exchange',
});

// Decoupled stacks process tagged resources or conditionally deploy
new BackupStack(app, 'BackupStack');
new MonitoringStack(app, 'MonitoringStack');
new PerformanceStack(app, 'PerformanceStack');
