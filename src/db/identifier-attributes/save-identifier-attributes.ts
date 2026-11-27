import type { Queryable } from '../dsql-clients.js';
import type { IdentifierAttributeDto } from './identifier-attribute.js';

/** Attribute values as the API accepts them. */
export type AttributeValue = string | Record<string, unknown>;

/** Strings are stored as they are; objects as JSON. */
export const serialiseAttributeValue = (value: AttributeValue): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/**
 * Encrypts each attribute (one KMS data key per value, bound to the linked
 * identifier and attribute name) and upserts them all in one statement, so a
 * repeated request leaves one row per name holding the latest value.
 */
export const saveIdentifierAttributes = async (
  tx: Queryable,
  dto: IdentifierAttributeDto,
  linkedIdentifierId: string,
  attributes: Readonly<Record<string, AttributeValue>>,
): Promise<number> => {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    return 0;
  }

  const encrypted = await Promise.all(
    entries.map(async ([name, value]) => ({
      name,
      ...(await dto.encryptValue(linkedIdentifierId, name, serialiseAttributeValue(value))),
    })),
  );

  // $1 is the linked identifier; each attribute adds name, value, data_key.
  const params: unknown[] = [linkedIdentifierId];
  const rows = encrypted.map(({ name, value, dataKey }) => {
    params.push(name, value, dataKey);
    const n = params.length;
    return `($1::uuid, $${n - 2}, $${n - 1}, $${n})`;
  });

  await tx.query(
    `INSERT INTO identifier_attributes (linked_identifier_id, name, value, data_key)
     VALUES ${rows.join(', ')}
     ON CONFLICT (linked_identifier_id, name)
     DO UPDATE SET value = EXCLUDED.value, data_key = EXCLUDED.data_key`,
    params,
  );
  return encrypted.length;
};
