import type { Queryable } from '../dsql-clients.js';
import {
  ANCHORING_DOMAINS,
  IDX_DOMAIN,
  type LinkedIdentifier,
  type LinkedIdentifierDSQL,
  toLinkedIdentifier,
} from './linked-identifier.js';

export interface LinkIdentifierInput {
  domain: string;
  domainId: string;
  linkedDomain: string;
  linkedDomainId: string;
  scope?: string | undefined;
  scopeId?: string | undefined;
}

export interface LinkIdentifierResult {
  link: LinkedIdentifier;
  /** False when the link already existed (nothing was inserted for it). */
  created: boolean;
}

const COLUMNS =
  'id, domain, domain_id, linked_domain, linked_domain_id, scope, scope_id, idx_id, created_at';

// Compile-time constants, so safe to inline as SQL literals.
const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const IDX = sqlLiteral(IDX_DOMAIN);
const ANCHORING = ANCHORING_DOMAINS.map(sqlLiteral).join(', ');

/**
 * One round trip that, in a single statement:
 *
 * 1. for an anchoring domain, inserts an IdX anchor for (domain, domain_id)
 *    with the minted idx_id ($7), unless one already exists;
 * 2. resolves the idx_id from the new anchor or the existing one (NULL for a
 *    non-anchoring domain with no anchor);
 * 3. inserts the link with that idx_id, unless the same link exists;
 * 4. returns the new link with created = true, or the existing one with
 *    created = false.
 *
 * Every CTE sees the same snapshot, which is why steps 2 and 4 union the
 * RETURNING rows with a lookup rather than re-reading the table. Concurrent
 * requests for the same link conflict at COMMIT (DSQL OCC); the retry then
 * finds the committed row and returns it with created = false.
 *
 * Parameters are cast because each is used in more than one place, where
 * Postgres could otherwise deduce different types.
 */
export const LINK_IDENTIFIER_SQL = `
WITH
inserted_anchor AS (
    INSERT INTO linked_identifiers (id, domain, domain_id, linked_domain, linked_domain_id, idx_id)
    SELECT gen_random_uuid(), $1::text, $2::uuid, ${IDX}, $7::uuid, NULL
    WHERE $1::text IN (${ANCHORING})
    ON CONFLICT (domain, domain_id) WHERE linked_domain = ${IDX} DO NOTHING
    RETURNING linked_domain_id AS idx_val
),
resolved_anchor AS (
    SELECT idx_val FROM inserted_anchor
    UNION ALL
    SELECT linked_domain_id AS idx_val
    FROM linked_identifiers
    WHERE domain = $1::text
      AND domain_id = $2::uuid
      AND linked_domain = ${IDX}
      AND NOT EXISTS (SELECT 1 FROM inserted_anchor)
    LIMIT 1
),
inserted_link AS (
    INSERT INTO linked_identifiers (
        id, domain, domain_id, linked_domain, linked_domain_id, scope, scope_id, idx_id
    )
    SELECT
        gen_random_uuid(), $1::text, $2::uuid, $3::text, $4::uuid, $5::text, $6::text, ra.idx_val
    FROM (SELECT 1) AS dummy
    LEFT JOIN resolved_anchor ra ON TRUE
    ON CONFLICT (
        domain, domain_id, linked_domain, linked_domain_id, COALESCE(scope, ''), COALESCE(scope_id, '')
    ) DO NOTHING
    RETURNING ${COLUMNS}
)
SELECT ${COLUMNS}, TRUE AS created
FROM inserted_link
UNION ALL
SELECT ${COLUMNS}, FALSE AS created
FROM linked_identifiers
WHERE domain = $1::text
  AND domain_id = $2::uuid
  AND linked_domain = $3::text
  AND linked_domain_id = $4::uuid
  AND COALESCE(scope, '') = COALESCE($5::text, '')
  AND COALESCE(scope_id, '') = COALESCE($6::text, '')
  AND NOT EXISTS (SELECT 1 FROM inserted_link)
LIMIT 1
`;

/**
 * Links two identifiers, minting an IdX anchor first when the domain is an
 * anchoring one (see LINK_IDENTIFIER_SQL). Idempotent: run it in a
 * transaction, with `mintedIdxId` a fresh UUID per attempt.
 */
export const linkIdentifier = async (
  tx: Queryable,
  input: LinkIdentifierInput,
  mintedIdxId: string,
): Promise<LinkIdentifierResult> => {
  const { rows } = await tx.query(LINK_IDENTIFIER_SQL, [
    input.domain,
    input.domainId,
    input.linkedDomain,
    input.linkedDomainId,
    input.scope ?? null,
    input.scopeId ?? null,
    mintedIdxId,
  ]);
  const row = rows[0] as unknown as (LinkedIdentifierDSQL & { created: boolean }) | undefined;
  if (!row) {
    // The insert conflicted with a link committed after this transaction's
    // snapshot, so the fallback lookup cannot see it. Report it as a
    // serialization failure so runInTransaction retries with a new snapshot.
    throw Object.assign(new Error('Link conflicted with a concurrent insert'), { code: '40001' });
  }
  const { created, ...linkRow } = row;
  return { link: toLinkedIdentifier(linkRow), created };
};
