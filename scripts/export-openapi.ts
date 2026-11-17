/**
 * Writes the Exchange API's OpenAPI 3.0 spec to docs/openapi.json.
 *
 *   pnpm export:openapi           regenerate the file
 *   pnpm export:openapi --check   exit 1 if the file is out of date
 *
 * The spec is built from the route definitions in src/routes, the same ones
 * ExchangeApiStack turns into API Gateway models and validators, so nothing
 * needs to be deployed. Any error (e.g. a schema JSON Schema cannot express)
 * exits non-zero, which blocks the commit when run from the pre-commit hook.
 *
 * Why not export the spec from CDK or API Gateway? None of the options work
 * offline (in a hook or a unit test):
 * - aws-cdk-lib has no `exportApiDefinition()` on RestApi.
 * - `SpecRestApi` takes an OpenAPI document as input; it never produces one.
 * - `RestApi` synthesizes separate AWS::ApiGateway::Resource/Method/Model
 *   resources, not an OpenAPI body.
 * - `aws apigateway get-export` needs a deployed stage and AWS credentials,
 *   and describes the last deployment, not the code being committed.
 * Generating from the route definitions that createRoute
 * (cdk/lib/api/create-route.ts) also consumes means the spec cannot drift from
 * the deployed models and validators.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { OPENAPI_SPEC_PATH, exchangeApiSpec } from '../cdk/lib/api/exchange-api-spec.js';
import { serialiseOpenApiSpec } from '../cdk/lib/api/openapi.js';

const readCurrent = (): string | undefined => {
  try {
    return readFileSync(OPENAPI_SPEC_PATH, 'utf8');
  } catch {
    return undefined;
  }
};

const main = () => {
  const check = process.argv.includes('--check');
  const generated = serialiseOpenApiSpec(exchangeApiSpec());
  const relativePath = path.relative(process.cwd(), OPENAPI_SPEC_PATH);
  const upToDate = readCurrent() === generated;

  if (check) {
    if (!upToDate) {
      process.stderr.write(`${relativePath} is out of date: run pnpm export:openapi\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (!upToDate) {
    writeFileSync(OPENAPI_SPEC_PATH, generated);
  }
  process.stdout.write(`${relativePath} ${upToDate ? 'is up to date' : 'updated'}\n`);
};

try {
  main();
} catch (error) {
  process.stderr.write(
    `OpenAPI export failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
