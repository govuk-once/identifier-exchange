import { z } from 'zod';

type Override = NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override'];

/**
 * Request objects reject unknown keys unless the schema says otherwise.
 *
 * Zod's `z.object` strips unknown keys when parsing, and its JSON Schema
 * leaves `additionalProperties` unset, which API Gateway reads as "anything
 * goes". Closing objects means a misspelt or unexpected field is rejected at
 * the gateway instead of reaching Lambda. Use `z.looseObject` to allow extra
 * keys; records (`z.record`) are unaffected.
 */
const rejectUnknownKeys: Override = ({ zodSchema, jsonSchema }) => {
  if (zodSchema._zod.def.type === 'object' && jsonSchema.additionalProperties === undefined) {
    jsonSchema.additionalProperties = false;
  }
};

/**
 * A Zod schema as JSON Schema, for API Gateway models (`draft-4`) or the
 * OpenAPI document (`openapi-3.0`).
 *
 * `input` describes what a client may send, with objects closed (see
 * rejectUnknownKeys); `output` describes what a handler returns. Throws for
 * types JSON Schema cannot express (transforms, dates, ...), so synth and the
 * OpenAPI export fail rather than ship an unvalidated schema.
 */
export const toJsonSchema = (
  schema: z.ZodType,
  target: 'draft-4' | 'openapi-3.0',
  io: 'input' | 'output',
) =>
  z.toJSONSchema(schema, {
    target,
    io,
    ...(io === 'input' && { override: rejectUnknownKeys }),
  });
