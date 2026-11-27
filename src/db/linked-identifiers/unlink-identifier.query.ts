import type { Queryable } from '../dsql-clients.js';
import { IDX_DOMAIN } from './linked-identifier.js';

export interface UnlinkIdentifierInput {
  domain: string;
  domainId: string;
  linkedDomain: string;
  /** Omitted: every linkedDomainId. */
  linkedDomainId?: string | undefined;
  /** Omitted: any scope, including none. */
  scope?: string | undefined;
  /** Omitted: any scope_id, including none. */
  scopeId?: string | undefined;
}

export interface UnlinkIdentifierResult {
  /** IDs of the linked_identifiers rows deleted; empty when none matched. */
  removedLinkIds: string[];
  /** True when the IdX anchor was deleted because no links to it remained. */
  anchorDeleted: boolean;
}

// The IdX anchor of (domain, domain_id). FOR UPDATE does not block in DSQL:
// it adds the row to this transaction's commit-time conflict check, as if it
// had been written. Two unlinks against one anchor therefore conflict, and
// the retry sees the other's deletion, so the last one out always removes
// the anchor. Needs UPDATE privilege (20261127141418_grant_delete_role_row_lock).
export const LOCK_ANCHOR_SQL = `
SELECT id, linked_domain_id
FROM linked_identifiers
WHERE domain = $1::text
  AND domain_id = $2::uuid
  AND linked_domain = '${IDX_DOMAIN}'
FOR UPDATE`;

// An omitted optional parameter (NULL) matches any value. linked_domain <>
// IdX keeps anchor rows out even if validation were bypassed.
export const DELETE_LINKS_SQL = `
DELETE FROM linked_identifiers
WHERE domain = $1::text
  AND domain_id = $2::uuid
  AND linked_domain = $3::text
  AND linked_domain <> '${IDX_DOMAIN}'
  AND ($4::uuid IS NULL OR linked_domain_id = $4::uuid)
  AND ($5::text IS NULL OR scope = $5::text)
  AND ($6::text IS NULL OR scope_id = $6::text)
RETURNING id, idx_id`;

// Anchor rows have a NULL idx_id, so this only finds links to the anchor.
// Sees this transaction's own deletions.
export const REMAINING_LINK_SQL = `
SELECT 1 FROM linked_identifiers WHERE idx_id = $1::uuid LIMIT 1`;

export const DELETE_ANCHOR_SQL = `
DELETE FROM linked_identifiers WHERE id = $1::uuid AND linked_domain = '${IDX_DOMAIN}'`;

// DSQL has no foreign keys, so attributes are removed explicitly.
export const DELETE_ATTRIBUTES_SQL = `
DELETE FROM identifier_attributes WHERE linked_identifier_id = ANY($1::uuid[])`;

interface AnchorRow {
  id: string;
  linked_domain_id: string;
}

interface DeletedLinkRow {
  id: string;
  idx_id: string | null;
}

/**
 * Hard-deletes the matching links and their identifier_attributes, then the
 * IdX anchor of (domain, domainId) if no links to it remain. Run it inside
 * runInTransaction: it is safe to repeat, and a second run (or a run with
 * nothing to match) deletes nothing and reports no removed links.
 */
export const unlinkIdentifier = async (
  tx: Queryable,
  input: UnlinkIdentifierInput,
): Promise<UnlinkIdentifierResult> => {
  const { rows: anchorRows } = await tx.query(LOCK_ANCHOR_SQL, [input.domain, input.domainId]);
  const anchor = anchorRows[0] as unknown as AnchorRow | undefined;

  const { rows } = await tx.query(DELETE_LINKS_SQL, [
    input.domain,
    input.domainId,
    input.linkedDomain,
    input.linkedDomainId ?? null,
    input.scope ?? null,
    input.scopeId ?? null,
  ]);
  const deleted = rows as unknown as DeletedLinkRow[];
  if (deleted.length === 0) {
    return { removedLinkIds: [], anchorDeleted: false };
  }

  const removedLinkIds = deleted.map(({ id }) => id);
  const attributeOwnerIds = [...removedLinkIds];

  let anchorDeleted = false;
  const idxId = anchor?.linked_domain_id;
  if (anchor && deleted.some((row) => row.idx_id === idxId)) {
    const { rows: remaining } = await tx.query(REMAINING_LINK_SQL, [idxId]);
    if (remaining.length === 0) {
      await tx.query(DELETE_ANCHOR_SQL, [anchor.id]);
      attributeOwnerIds.push(anchor.id);
      anchorDeleted = true;
    }
  }

  await tx.query(DELETE_ATTRIBUTES_SQL, [attributeOwnerIds]);
  return { removedLinkIds, anchorDeleted };
};
