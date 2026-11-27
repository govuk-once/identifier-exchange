import { z } from 'zod';
import { createApiHandler, nullAsEmpty } from '../api/create-api-handler.js';
import { requireEnvVars } from '../api/require-env-vars.js';
import { createDsqlClients } from '../db/dsql-clients.js';
import { unlinkIdentifier } from '../db/linked-identifiers/unlink-identifier.query.js';
import {
  type UnlinkIdentifierResponse,
  unlinkIdentifierPathParams,
  unlinkIdentifierQueryParams,
} from '../routes/unlink-identifier.route.js';

// DELETE /unlink/{domain}/{domainId}/{linkedDomain}: hard-deletes the
// matching links and their attributes, and the IdX anchor with its last
// link. Idempotent: 200 whether or not anything matched.

const { CLUSTER_ENDPOINT } = requireEnvVars('CLUSTER_ENDPOINT');

// unlinkIdentifierRoute has databaseAccess 'delete', so the function runs as
// DeleteDbRole and connects as delete_role, the only role that can DELETE.
const dsqlClients = createDsqlClients(['delete'], { host: CLUSTER_ENDPOINT });

// API Gateway only checks that required parameters are present; it cannot
// check their format. Validate again with the route's own schemas.
const requestSchema = z.looseObject({
  pathParameters: nullAsEmpty(unlinkIdentifierPathParams),
  queryStringParameters: nullAsEmpty(unlinkIdentifierQueryParams),
});

export const handler = createApiHandler(
  async (event, { dsql, runInTransaction, logger }) => {
    const input = { ...event.pathParameters, ...event.queryStringParameters };

    // Retried as a whole on OCC conflicts and transient errors; a retry
    // starts from a fresh snapshot, so it deletes only what is still there.
    const { removedLinkIds, anchorDeleted } = await runInTransaction(dsql.deleteClient, (tx) =>
      unlinkIdentifier(tx, input),
    );

    logger.info(removedLinkIds.length > 0 ? 'Links removed' : 'No matching link', {
      domain: input.domain,
      linkedDomain: input.linkedDomain,
      removedLinkIds,
      anchorDeleted,
    });
    const body: UnlinkIdentifierResponse = { unlinked: true, anchorDeleted };
    return { statusCode: 200, body };
  },
  {
    serviceName: 'exchange-api unlinkIdentifier',
    zodRequestValidator: requestSchema,
    dsqlClients,
  },
);
