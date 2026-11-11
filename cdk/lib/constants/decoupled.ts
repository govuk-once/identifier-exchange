// A const object rather than an enum: Node's type stripping (used by `cdk synth`)
// does not support enums.
export const DecoupledTagKeys = {
  Backup: 'Backup',
  Monitor: 'Monitor',
} as const;
export type DecoupledTagKeys = (typeof DecoupledTagKeys)[keyof typeof DecoupledTagKeys];
