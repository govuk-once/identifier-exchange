/**
 * Makes a response body safe to serialise and predictable for clients:
 *
 * - Date -> ISO 8601 string (pg returns TIMESTAMPTZ columns as Dates);
 * - bigint -> string (JSON.stringify throws on bigint, and a BIGINT id can
 *   exceed Number.MAX_SAFE_INTEGER);
 * - object keys whose value is undefined, a function or a symbol are dropped,
 *   and such array entries become null, as JSON.stringify would;
 * - anything with a toJSON() (e.g. Buffer) is left for JSON.stringify.
 *
 * Returns a new value; the input is not modified.
 */
export const sanitiseResponse = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => (isDropped(item) ? null : sanitiseResponse(item)));
  }
  if (value !== null && typeof value === 'object' && !hasToJson(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        isDropped(item) ? [] : [[key, sanitiseResponse(item)]],
      ),
    );
  }
  return value;
};

const isDropped = (value: unknown) =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol';

const hasToJson = (value: object) => typeof (value as { toJSON?: unknown }).toJSON === 'function';
