import { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { describeIssues, errorResponse, jsonResponse } from '../api/errors.js';
import {
  type GetItemResponse,
  getItemPathParams,
  getItemQueryParams,
} from '../routes/get-item.route.js';

const logger = new Logger({ serviceName: 'exchange-api' });

/**
 * Looks up an item by ID.
 *
 * TODO: replace with the real lookup once the item store exists.
 */
export const findItem = async (_id: string): Promise<GetItemResponse | undefined> => undefined;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const requestId = event.requestContext.requestId;

  // API Gateway only checks that required parameters are present; it cannot
  // check their format. Validate again with the route's own schemas.
  const params = getItemPathParams.safeParse(event.pathParameters ?? {});
  const query = getItemQueryParams.safeParse(event.queryStringParameters ?? {});
  if (!params.success || !query.success) {
    return errorResponse(400, {
      code: 'BAD_REQUEST',
      message: 'Invalid request parameters',
      details: [
        ...(params.success ? [] : describeIssues(params.error)),
        ...(query.success ? [] : describeIssues(query.error)),
      ],
      requestId,
    });
  }

  try {
    const item = await findItem(params.data.id);
    if (!item) {
      return errorResponse(404, {
        code: 'NOT_FOUND',
        message: `Item ${params.data.id} not found`,
        requestId,
      });
    }
    return jsonResponse(200, item);
  } catch (error) {
    logger.error('getItem failed', { error, requestId });
    return errorResponse(500, {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      requestId,
    });
  }
};
