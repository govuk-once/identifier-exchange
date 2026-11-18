// Entry point for the fixture routes in ./routes.ts. NodejsFunction checks the
// entry exists, but the CDK tests skip bundling, so this never runs.
export const handler = async () => ({ statusCode: 204, body: '' });
