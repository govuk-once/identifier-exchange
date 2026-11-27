import type { Queryable } from '../dsql-clients.js';
import {
  type EncryptedAttribute,
  type IdentifierAttribute,
  IdentifierAttributeDto,
} from '../identifier-attributes/identifier-attribute.dto.js';
import {
  type LinkedIdentifier,
  type LinkedIdentifierDSQL,
  toLinkedIdentifier,
} from './linked-identifier.js';

/**
 * Bidirectional exchange: resolves the caller's idx_id group, then returns
 * every link in that group that touches the target domain, on either side, with
 * its (still encrypted) attributes. One row per link and attribute; a link
 * with no attributes has one row with NULL attribute columns.
 *
 * $1 = caller domain, $2 = caller domain_id, $3 = target domain.
 *
 * caller_group finds the idx_id either from a link row the caller is on (Case
 * A, either side) or from the caller's IdX anchor row, whose linked_domain_id
 * is the idx_id (Case B). Anchor rows have a NULL idx_id, so they never join
 * to the group and the idx_id is never "exchanged" as an identifier.
 */
export const EXCHANGE_IDENTIFIER_SQL = `
WITH caller_group AS (
    SELECT idx_id
    FROM linked_identifiers
    WHERE idx_id IS NOT NULL
      AND (
          (domain = $1 AND domain_id = $2)
          OR (linked_domain = $1 AND linked_domain_id = $2)
      )
    UNION
    SELECT linked_domain_id AS idx_id
    FROM linked_identifiers
    WHERE domain = $1
      AND domain_id = $2
      AND linked_domain = 'IdX'
)
SELECT
    li.id,
    li.domain,
    li.domain_id,
    li.linked_domain,
    li.linked_domain_id,
    li.scope,
    li.scope_id,
    li.idx_id,
    li.created_at,
    CASE
        WHEN li.linked_domain = $3 THEN li.linked_domain_id
        WHEN li.domain = $3 THEN li.domain_id
    END AS exchanged_id,
    $3::text AS exchanged_domain,
    ia.id AS attribute_id,
    ia.name AS attribute_name,
    ia.value AS attribute_value,
    ia.data_key AS attribute_data_key,
    ia.created_at AS attribute_created_at
FROM linked_identifiers li
INNER JOIN caller_group cg ON li.idx_id = cg.idx_id
LEFT JOIN identifier_attributes ia ON ia.linked_identifier_id = li.id
WHERE (li.linked_domain = $3 OR li.domain = $3)
ORDER BY li.created_at DESC, ia.name ASC`;

/** A row of EXCHANGE_IDENTIFIER_SQL as the pg driver returns it. */
export interface ExchangeIdentifierRowDSQL extends LinkedIdentifierDSQL {
  exchanged_id: string;
  exchanged_domain: string;
  attribute_id: string | null;
  attribute_name: string | null;
  attribute_value: string | null;
  attribute_data_key: string | null;
  attribute_created_at: Date | string | null;
}

/** A link in the caller's group that reaches the target domain. */
export interface ExchangedIdentifier<TAttribute = IdentifierAttribute> extends LinkedIdentifier {
  /** The identifier in the target domain, whichever side of the link it is on. */
  exchangedId: string;
  exchangedDomain: string;
  /** In attribute name order; empty when the link has none. */
  attributes: TAttribute[];
}

/** An attribute as returned to callers: decrypted, without its data key. */
export interface LinkedAttribute {
  id: string;
  name: string;
  value: string;
  /** ISO 8601, UTC. */
  createdAt: string;
}

export interface ExchangeIdentifierParams {
  domain: string;
  domainId: string;
  linkedDomain: string;
}

/**
 * Folds the one-row-per-attribute result into one DTO per link, keeping the
 * query's order (newest link first, attributes by name).
 */
export const toExchangedIdentifiers = (
  rows: readonly ExchangeIdentifierRowDSQL[],
): ExchangedIdentifier[] => {
  const byId = new Map<string, ExchangedIdentifier>();
  for (const row of rows) {
    let link = byId.get(row.id);
    if (!link) {
      link = {
        ...toLinkedIdentifier(row),
        exchangedId: row.exchanged_id,
        exchangedDomain: row.exchanged_domain,
        attributes: [],
      };
      byId.set(row.id, link);
    }
    if (
      row.attribute_id !== null &&
      row.attribute_name !== null &&
      row.attribute_value !== null &&
      row.attribute_data_key !== null &&
      row.attribute_created_at !== null
    ) {
      link.attributes.push(
        IdentifierAttributeDto.fromRow({
          id: row.attribute_id,
          linked_identifier_id: row.id,
          name: row.attribute_name,
          value: row.attribute_value,
          data_key: row.attribute_data_key,
          created_at: row.attribute_created_at,
        }),
      );
    }
  }
  return [...byId.values()];
};

/** Runs the exchange query. An empty result means no group or no link to the target. */
export const findExchangedIdentifiers = async (
  db: Queryable,
  { domain, domainId, linkedDomain }: ExchangeIdentifierParams,
): Promise<ExchangedIdentifier[]> => {
  const { rows } = await db.query(EXCHANGE_IDENTIFIER_SQL, [domain, domainId, linkedDomain]);
  return toExchangedIdentifiers(rows as unknown as ExchangeIdentifierRowDSQL[]);
};

/** Replaces each attribute's ciphertext with its plaintext and drops the data key. */
export const decryptExchangedIdentifiers = (
  links: readonly ExchangedIdentifier[],
  decrypt: (attribute: EncryptedAttribute) => Promise<string>,
): Promise<ExchangedIdentifier<LinkedAttribute>[]> =>
  Promise.all(
    links.map(async ({ attributes, ...link }) => ({
      ...link,
      attributes: await Promise.all(
        attributes.map(async (attribute) => ({
          id: attribute.id,
          name: attribute.name,
          value: await decrypt(attribute),
          createdAt: attribute.createdAt,
        })),
      ),
    })),
  );
