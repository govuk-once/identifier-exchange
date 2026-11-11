// Const objects rather than enums: Node's type stripping (used by `cdk synth`)
// does not support enums.
export const GovUkOnceEnvironments = {
  Dev: 'dev',
  Test: 'test',
  Stag: 'stag',
  Prod: 'prod',
} as const;
export type GovUkOnceEnvironments =
  (typeof GovUkOnceEnvironments)[keyof typeof GovUkOnceEnvironments];

export const GovUkOnceFullEnvironments = {
  Dev: 'development',
  Test: 'testing',
  Stag: 'staging',
  Prod: 'production',
} as const;
export type GovUkOnceFullEnvironments =
  (typeof GovUkOnceFullEnvironments)[keyof typeof GovUkOnceFullEnvironments];
