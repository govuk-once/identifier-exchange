-- linked_identifiers: relationships between identifiers across domains
-- (App, Web, DVLA, HMRC, UDP, IdX, ...) with an optional scope qualifier
-- (scope / scope_id, e.g. a device).
--
-- Anchor rows (linked_domain = 'IdX') give a domain identifier its idx_id
-- (held in linked_domain_id); other rows point back to it through idx_id,
-- which is NULL on the anchor rows themselves.
--
-- This file is the reference schema for Aurora DSQL. The migration
-- src/db/migrations/20261126141927_create_linked_identifiers.ts applies it,
-- one statement per transaction, and linked-identifiers.schema.test.ts keeps
-- the two in step.

CREATE TABLE IF NOT EXISTS linked_identifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain TEXT NOT NULL,
    domain_id UUID NOT NULL,
    linked_domain TEXT NOT NULL,
    linked_domain_id UUID NOT NULL,
    scope TEXT,
    scope_id TEXT,
    idx_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one IdX anchor per (domain, domain_id); non-anchor rows are not
-- covered, so one identifier can link to many other domains.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_linked_identifiers_anchor
ON linked_identifiers (domain, domain_id)
WHERE linked_domain = 'IdX';

-- No duplicate links. COALESCE makes a NULL scope / scope_id match another
-- NULL, so an unscoped link can't be inserted twice.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_linked_identifiers_unique_link
ON linked_identifiers (
    domain,
    domain_id,
    linked_domain,
    linked_domain_id,
    COALESCE(scope, ''),
    COALESCE(scope_id, '')
);

-- Lookups by idx_id (exchange, unlink, CDC enrichment). Not unique: many
-- linked rows share an idx_id. Anchor rows (idx_id IS NULL) are left out.
CREATE INDEX ASYNC IF NOT EXISTS idx_linked_identifiers_idx_id
ON linked_identifiers (idx_id)
WHERE idx_id IS NOT NULL;
