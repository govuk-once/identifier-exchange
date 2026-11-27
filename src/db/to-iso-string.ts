/**
 * pg parses TIMESTAMPTZ into a Date by default, but a row can arrive with
 * the raw string (a custom type parser, JSON from a queue). Either way DTOs
 * carry one ISO 8601 UTC format. `column` names the value in the error.
 */
export const toIsoString = (value: Date | string, column: string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${column} is not a valid timestamp: "${String(value)}"`);
  }
  return date.toISOString();
};
