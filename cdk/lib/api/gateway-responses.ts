import * as apigateway from 'aws-cdk-lib/aws-apigateway';

/**
 * A mapping template producing the API's error shape (`apiErrorResponse` in
 * src/api/errors.ts). `message` and `details` are VTL expressions or JSON
 * literals; `$context.error.messageString` is already quoted.
 */
const errorTemplate = (code: string, message: string, details?: string) =>
  [
    '{',
    `"code":${JSON.stringify(code)},`,
    `"message":${message},`,
    details ? `"details":[${details}],` : '',
    '"requestId":"$context.requestId"',
    '}',
  ].join('');

const literal = (text: string) => JSON.stringify(text);
const GATEWAY_MESSAGE = '$context.error.messageString';
const VALIDATION_ERROR = '"$context.error.validationErrorString"';

interface StandardResponse {
  type: apigateway.ResponseType;
  /** Omitted to keep API Gateway's own status (e.g. 429 for DEFAULT_4XX throttling). */
  statusCode?: string;
  template: string;
}

/**
 * Errors API Gateway itself returns, before or instead of invoking Lambda.
 * The specific types take precedence over DEFAULT_4XX / DEFAULT_5XX.
 */
export const STANDARD_GATEWAY_RESPONSES: Readonly<Record<string, StandardResponse>> = {
  BadRequestBody: {
    type: apigateway.ResponseType.BAD_REQUEST_BODY,
    statusCode: '400',
    template: errorTemplate(
      'BAD_REQUEST',
      literal('Request body failed validation'),
      VALIDATION_ERROR,
    ),
  },
  BadRequestParameters: {
    type: apigateway.ResponseType.BAD_REQUEST_PARAMETERS,
    statusCode: '400',
    template: errorTemplate(
      'BAD_REQUEST',
      literal('Missing required request parameters'),
      VALIDATION_ERROR,
    ),
  },
  Unauthorized: {
    type: apigateway.ResponseType.UNAUTHORIZED,
    statusCode: '401',
    template: errorTemplate('UNAUTHORIZED', literal('Missing or invalid authentication token')),
  },
  AccessDenied: {
    type: apigateway.ResponseType.ACCESS_DENIED,
    statusCode: '403',
    template: errorTemplate('FORBIDDEN', GATEWAY_MESSAGE),
  },
  // Also what API Gateway returns for a path or method that does not exist.
  MissingAuthenticationToken: {
    type: apigateway.ResponseType.MISSING_AUTHENTICATION_TOKEN,
    statusCode: '403',
    template: errorTemplate('FORBIDDEN', GATEWAY_MESSAGE),
  },
  InvalidSignature: {
    type: apigateway.ResponseType.INVALID_SIGNATURE,
    statusCode: '403',
    template: errorTemplate('FORBIDDEN', GATEWAY_MESSAGE),
  },
  IntegrationFailure: {
    type: apigateway.ResponseType.INTEGRATION_FAILURE,
    statusCode: '502',
    template: errorTemplate('BAD_GATEWAY', literal('The request could not be processed')),
  },
  IntegrationTimeout: {
    type: apigateway.ResponseType.INTEGRATION_TIMEOUT,
    statusCode: '504',
    template: errorTemplate('GATEWAY_TIMEOUT', literal('The request timed out')),
  },
  Default4XX: {
    type: apigateway.ResponseType.DEFAULT_4XX,
    template: errorTemplate('CLIENT_ERROR', GATEWAY_MESSAGE),
  },
  Default5XX: {
    type: apigateway.ResponseType.DEFAULT_5XX,
    template: errorTemplate('INTERNAL_SERVER_ERROR', literal('An unexpected error occurred')),
  },
};

/** Gives every error API Gateway generates the same JSON shape as handler errors. */
export const addStandardGatewayResponses = (api: apigateway.RestApi): void => {
  for (const [id, { type, statusCode, template }] of Object.entries(STANDARD_GATEWAY_RESPONSES)) {
    api.addGatewayResponse(id, {
      type,
      ...(statusCode && { statusCode }),
      templates: { 'application/json': template },
    });
  }
};
