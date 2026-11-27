/**
 * Reads environment variables that must be set, failing at cold start (with
 * every missing name) rather than on the first request that needs one.
 *
 *   const { CLUSTER_ENDPOINT } = requireEnvVars('CLUSTER_ENDPOINT');
 */
export const requireEnvVars = <const K extends string>(...names: K[]): Record<K, string> => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]])) as Record<K, string>;
};
