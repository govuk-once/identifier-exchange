import * as cdk from 'aws-cdk-lib';
import { ContextHelper } from '../lib/util/contextHelper';
import { BackupStack } from '../lib/stacks/backup.stack';
import { MonitoringStack } from '../lib/stacks/monitoring.stack';
import { PerformanceStack } from '../lib/stacks/performance.stack';
import { GovUkOnceEnvironments } from '../lib/constants/environment';
const app = new cdk.App();
ContextHelper.setAll(app, {
  environment: (process.env.ENV as GovUkOnceEnvironments) || GovUkOnceEnvironments.Dev,
});
// Decoupled stacks process tagged resources or conditionally deploy
new BackupStack(app, 'BackupStack');
new MonitoringStack(app, 'MonitoringStack');
new PerformanceStack(app, 'PerformanceStack');
