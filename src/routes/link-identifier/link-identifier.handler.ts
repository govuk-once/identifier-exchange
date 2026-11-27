import { randomUUID } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { createApiHandler } from '../../api/create-api-handler.js';
import { requireEnvVars } from '../../api/require-env-vars.js';
import { createDsqlClients } from '../../db/dsql-clients.js';
import { IdentifierAttributeDto } from '../../db/identifier-attributes/identifier-attribute.js';
import { saveIdentifierAttributes } from '../../db/identifier-attributes/save-identifier-attributes.js';
import { linkIdentifier } from '../../db/linked-identifiers/link-identifier.query.js';
import { linkIdentifierRequestBody } from './link-identifier.route.js';

// PUT /link: links a domain identifier to another domain's identifier,
// minting an IdX anchor for anchoring domains, and saves any attributes
// encrypted. Idempotent: 201 when the link is new, 200 when it existed.

const { CLUSTER_ENDPOINT, DATA_ENCRYPTION_KEY_ARN } = requireEnvVars(
  'CLUSTER_ENDPOINT',
  'DATA_ENCRYPTION_KEY_ARN',
);

// linkIdentifierRoute has databaseAccess 'readwrite', so the function runs as
// ReadWriteDbRole and connects as readwrite_role.
const dsqlClients = createDsqlClients(['write'], { host: CLUSTER_ENDPOINT });

const attributeDto = new IdentifierAttributeDto({
  kms: new KMSClient({}),
  keyId: DATA_ENCRYPTION_KEY_ARN,
});

// API Gateway validates the body's shape, but not refinements such as the
// UUID format; validate again with the route's own schema.
const requestSchema = z.looseObject({ body: linkIdentifierRequestBody });

export const handler = createApiHandler(
  async (event, { dsql, runInTransaction, logger }) => {
    const { attributes, ...input } = event.body;

    // Retried as a whole on OCC conflicts, so a retry mints a fresh idx_id
    // and re-encrypts the attributes; nothing from a failed attempt is kept.
    const { link, created } = await runInTransaction(dsql.writeClient, async (tx) => {
      const result = await linkIdentifier(tx, input, randomUUID());
      if (attributes) {
        await saveIdentifierAttributes(tx, attributeDto, result.link.id, attributes);
      }
      return result;
    });

    logger.info(created ? 'Link created' : 'Link already exists', {
      linkedIdentifierId: link.id,
      domain: link.domain,
      linkedDomain: link.linkedDomain,
      attributeCount: attributes ? Object.keys(attributes).length : 0,
    });
    return { statusCode: created ? 201 : 200, body: link };
  },
  {
    serviceName: 'exchange-api linkIdentifier',
    zodRequestValidator: requestSchema,
    dsqlClients,
  },
);
