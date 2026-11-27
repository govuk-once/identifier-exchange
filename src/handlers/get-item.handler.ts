import { z } from 'zod';
import { createApiHandler, nullAsEmpty } from '../api/create-api-handler.js';
import { NotFoundError } from '../api/http-errors.js';
import { requireEnvVars } from '../api/require-env-vars.js';
import { createDsqlClients, type TxClient } from '../db/dsql-clients.js';
import {
  type GetItemResponse,
  getItemPathParams,
  getItemQueryParams,
} from '../routes/get-item.route.js';

// EXAMPLE HANDLER showing the API handler pattern (see src/routes/index.ts to
// remove it). Module scope runs once per cold start: read config, create the
// pools for the route's database role, and build the handler.

const { CLUSTER_ENDPOINT } = requireEnvVars('CLUSTER_ENDPOINT');

// getItemRoute has databaseAccess 'readonly', so the function runs as
// ReadOnlyDbRole and can only connect as readonly_role.
const dsqlClients = createDsqlClients(['read'], { host: CLUSTER_ENDPOINT });

// API Gateway only checks that required parameters are present; it cannot
// check their format. Validate again with the route's own schemas.
const requestSchema = z.looseObject({
  pathParameters: nullAsEmpty(getItemPathParams),
  queryStringParameters: nullAsEmpty(getItemQueryParams),
});

interface ItemRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}
/**
 * Looks up an item by ID.
 *
 * TODO: replace with the real lookup once the item store exists. Until then
 * the query matches no rows, so every ID is not found.
 */
export const findItem = async (tx: TxClient, id: string): Promise<GetItemResponse | undefined> => {
  const { rows } = await tx.query(
    `SELECT $1::uuid AS id, 'example' AS name, 'active' AS status, now() AS created_at
     WHERE false`,
    [id],
  );
  const row = rows[0] as ItemRow | undefined;
  return (
    row && {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }
  );
};

export const handler = createApiHandler(
  async (event, { dsql, runInTransaction, logger }) => {
    const { id } = event.pathParameters;
    const item = await runInTransaction(dsql.readClient, async (tx) => {
      const found = await findItem(tx, id);
      if (!found) {
        throw new NotFoundError('NOT_FOUND', `Item ${id} not found`);
      }
      return found;
    });
    logger.info('Item found', { itemId: id });
    return { statusCode: 200, body: item };
  },
  {
    serviceName: 'exchange-api getItem',
    zodRequestValidator: requestSchema,
    dsqlClients,
  },
);
