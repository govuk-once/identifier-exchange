import { KMSClient } from '@aws-sdk/client-kms';
import { z } from 'zod';
import { createApiHandler, nullAsEmpty } from '../api/create-api-handler.js';
import { NotFoundError } from '../api/http-errors.js';
import { requireEnvVars } from '../api/require-env-vars.js';
import { createDsqlClients } from '../db/dsql-clients.js';
import { IdentifierAttributeDto } from '../db/identifier-attributes/identifier-attribute.dto.js';
import {
  decryptExchangedIdentifiers,
  findExchangedIdentifiers,
} from '../db/linked-identifiers/exchange-identifier.query.js';
import {
  type ExchangeIdentifierResponse,
  exchangeIdentifierPathParams,
} from '../routes/exchange-identifier.route.js';

const { CLUSTER_ENDPOINT, DATA_ENCRYPTION_KEY_ARN } = requireEnvVars(
  'CLUSTER_ENDPOINT',
  'DATA_ENCRYPTION_KEY_ARN',
);

// exchangeIdentifierRoute has databaseAccess 'readonly', so the function runs
// as ReadOnlyDbRole and can only connect as readonly_role. That role can also
// decrypt with the data encryption key (DataMigratorStack).
const dsqlClients = createDsqlClients(['read'], { host: CLUSTER_ENDPOINT });
const attributeDto = new IdentifierAttributeDto({
  kms: new KMSClient({}),
  keyId: DATA_ENCRYPTION_KEY_ARN,
});

// API Gateway only checks that path parameters are present; check their format.
const requestSchema = z.looseObject({
  pathParameters: nullAsEmpty(exchangeIdentifierPathParams),
});

export const handler = createApiHandler(
  async (event, { dsql, runInTransaction, logger }) => {
    const { domain, domainId, linkedDomain } = event.pathParameters;

    const links = await runInTransaction(dsql.readClient, async (tx) => {
      const found = await findExchangedIdentifiers(tx, { domain, domainId, linkedDomain });
      if (found.length === 0) {
        throw new NotFoundError(
          'NOT_FOUND',
          `No ${linkedDomain} identifier linked to ${domain} identifier ${domainId}`,
        );
      }
      return found;
    });

    // After the transaction, so no connection is held open during KMS calls.
    const linkedIdentifiers = await decryptExchangedIdentifiers(links, (attribute) =>
      attributeDto.decryptValue(attribute),
    );

    logger.info('Identifier exchanged', {
      domain,
      linkedDomain,
      linkCount: linkedIdentifiers.length,
    });
    const body: ExchangeIdentifierResponse = { domain, domainId, linkedDomain, linkedIdentifiers };
    return { statusCode: 200, body };
  },
  {
    serviceName: 'exchange-api exchangeIdentifier',
    zodRequestValidator: requestSchema,
    dsqlClients,
  },
);
