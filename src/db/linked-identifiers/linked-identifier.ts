/** linked_domain of IdX anchor rows, whose linked_domain_id is the idx_id. */
export const IDX_DOMAIN = 'IdX';

/**
 * Domains whose identifiers are anchored: linking one mints an IdX anchor
 * (and so an idx_id) for it if it does not have one yet.
 */
export const ANCHORING_DOMAINS = ['app', 'web'] as const;

/**
 * A linked_identifiers row as the pg driver returns it (snake_case columns).
 * Schema: src/db/schema/linked_identifiers.sql.
 */
export interface LinkedIdentifierDSQL {
  id: string;
  domain: string;
  domain_id: string;
  linked_domain: string;
  linked_domain_id: string;
  scope: string | null;
  scope_id: string | null;
  /** NULL on IdX anchor rows (linked_domain = 'IdX'). */
  idx_id: string | null;
  created_at: Date | string;
}

/** A linked_identifiers row as handlers and domain logic see it (camelCase). */
export interface LinkedIdentifier {
  id: string;
  domain: string;
  domainId: string;
  linkedDomain: string;
  linkedDomainId: string;
  scope: string | null;
  scopeId: string | null;
  /** Null on IdX anchor rows (linkedDomain = 'IdX'). */
  idxId: string | null;
  /** ISO 8601, UTC. */
  createdAt: string;
}

/**
 * pg parses TIMESTAMPTZ into a Date by default, but a row can arrive with
 * the raw string (a custom type parser, JSON from a queue). Either way the
 * DTO carries one ISO 8601 UTC format.
 */
const toIsoString = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(
      `linked_identifiers.created_at is not a valid timestamp: "${String(value)}"`,
    );
  }
  return date.toISOString();
};

/** Maps a database row to the camelCase DTO, keeping nulls as null. */
export const toLinkedIdentifier = (row: LinkedIdentifierDSQL): LinkedIdentifier => ({
  id: row.id,
  domain: row.domain,
  domainId: row.domain_id,
  linkedDomain: row.linked_domain,
  linkedDomainId: row.linked_domain_id,
  scope: row.scope,
  scopeId: row.scope_id,
  idxId: row.idx_id,
  createdAt: toIsoString(row.created_at),
});
