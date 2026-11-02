import * as cdk from 'aws-cdk-lib';
// import { ContextHelper } from '../lib/util/contextHelper';
import { BackupStack } from '../lib/stacks/backup.stack';
import { MonitoringStack } from '../lib/stacks/monitoring.stack';
import { PerformanceStack } from '../lib/stacks/performance.stack';
const app = new cdk.App();
// ContextHelper.setAll(app, {
//   environment: (process.env.ENV as 'dev' | 'staging' | 'prod') || 'dev',
// });
// Decoupled stacks process tagged resources or conditionally deploy
new BackupStack(app, 'BackupStack');
new MonitoringStack(app, 'MonitoringStack');
new PerformanceStack(app, 'PerformanceStack');