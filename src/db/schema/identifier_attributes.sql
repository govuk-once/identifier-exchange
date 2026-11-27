-- identifier_attributes: attribute key/value pairs for a linked_identifiers
-- row (e.g. the { attributes: { ... } } object saved through the API).
--
-- linked_identifier_id refers to linked_identifiers.id. Aurora DSQL does not
-- support foreign key constraints, so the application enforces it.
--
-- value is encrypted by the application (AES-256-GCM under a KMS data key,
-- see IdentifierAttributeDto); data_key holds that data key as wrapped by
-- KMS. DSQL's own encryption at rest is cluster-wide, not per column.
--
-- This file is the reference schema for Aurora DSQL. The migration
-- src/db/migrations/20261126152208_create_identifier_attributes.ts applies
-- it, one statement per transaction, and identifier-attributes.schema.test.ts
-- keeps the two in step.

CREATE TABLE IF NOT EXISTS identifier_attributes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    linked_identifier_id UUID NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    data_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One attribute of each name per linked identifier, so saving an attributes
-- object can upsert idempotently.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_identifier_attributes_linked_id_name
ON identifier_attributes (linked_identifier_id, name);

-- Fetching (or cleaning up) every attribute of a linked identifier during
-- link, unlink and CDC flows.
CREATE INDEX ASYNC IF NOT EXISTS idx_identifier_attributes_linked_identifier_id
ON identifier_attributes (linked_identifier_id);
