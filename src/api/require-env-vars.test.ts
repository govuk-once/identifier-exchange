import { afterEach, describe, expect, test, vi } from 'vitest';
import { requireEnvVars } from './require-env-vars.js';

describe('requireEnvVars', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('returns the values when all are set', () => {
    vi.stubEnv('A_VAR', 'a');
    vi.stubEnv('B_VAR', 'b');

    expect(requireEnvVars('A_VAR', 'B_VAR')).toEqual({ A_VAR: 'a', B_VAR: 'b' });
  });

  test('names every missing or empty variable', () => {
    vi.stubEnv('A_VAR', '');
    vi.stubEnv('C_VAR', 'c');

    expect(() => requireEnvVars('A_VAR', 'B_VAR', 'C_VAR')).toThrow(
      'Missing required environment variables: A_VAR, B_VAR',
    );
  });
});
