import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { z } from 'zod';
import {
  type DsqlClients,
  type RunInTransactionFn,
  runInTransaction,
  withRetry,
} from '../db/dsql-clients.js';
import { errorResponse } from './errors.js';
import { HttpError, mapErrorToHttpResponse } from './http-errors.js';
import { sanitiseResponse } from './sanitise.js';

// The shared wrapper for API route handlers, in place of a middleware chain.
// Per invocation, in this order, it:
//   1. adds the Lambda context to the logger and opens an X-Ray subsegment;
//   2. parses a JSON body (400 if it is not JSON);
//   3. validates the event with the handler's Zod schema (400 on failure);
//   4. calls the handler with the validated event and a HandlerContext;
//   5. sanitises and serialises the body it returns;
//   6. maps a thrown HttpError to its response, and anything else to a 500;
//   7. closes the subsegment.

export type WithRetryFn = typeof withRetry;

export interface HandlerContext<TClients = DsqlClients> {
  logger: Logger;
  tracer: Tracer;
  /** The pools passed as `dsqlClients`; empty when none were. */
  dsql: TClients;
  withRetry: WithRetryFn;
  runInTransaction: RunInTransactionFn;
  lambdaContext: Context;
  /** API Gateway's request ID, also added to error responses. */
  requestId: string;
}

export interface HandlerResponse {
  statusCode: number;
  /** Serialised as JSON. Omit for an empty body. */
  body?: unknown;
  headers?: Record<string, string>;
}

/** The proxy event after JSON body parsing, before validation. */
export type ParsedEvent = Omit<APIGatewayProxyEvent, 'body'> & { body: unknown };

export type ValidatedEvent<TSchema> = TSchema extends z.ZodType ? z.output<TSchema> : ParsedEvent;

export interface ApiHandlerOptions<TSchema extends z.ZodType | undefined, TClients> {
  /** Defaults to POWERTOOLS_SERVICE_NAME, which ExchangeApiStack sets. */
  serviceName?: string;
  /**
   * Parses the whole event (after JSON body parsing). Use z.looseObject so
   * fields the schema does not name are kept, and nullAsEmpty() for
   * pathParameters / queryStringParameters, which API Gateway sends as null
   * when there are none. Issues are reported without the event location, so
   * `pathParameters.id` is reported as `id`.
   */
  zodRequestValidator?: TSchema;
  /** From createDsqlClients, at module scope so pools outlive invocations. */
  dsqlClients?: TClients;
  /**
   * Adds the response body to the X-Ray subsegment as metadata. Off by
   * default: bodies hold identifiers that should not be copied into traces.
   */
  captureResponse?: boolean;
  /** Runs the body through sanitiseResponse. On by default. */
  sanitise?: boolean;
  /** For tests. */
  logger?: Logger;
  tracer?: Tracer;
}

/** API Gateway sends `null` for absent path / query parameters and headers. */
export const nullAsEmpty = <S extends z.ZodType>(schema: S) =>
  z.preprocess((value) => value ?? {}, schema);

const EVENT_LOCATIONS = new Set<PropertyKey>([
  'pathParameters',
  'queryStringParameters',
  'headers',
  'body',
]);

/** One line per issue, e.g. `id: Item ID must be a valid UUID`. */
const describeEventIssues = (error: z.ZodError) =>
  error.issues.map((issue) => {
    const path = EVENT_LOCATIONS.has(issue.path[0] ?? '') ? issue.path.slice(1) : issue.path;
    return path.length > 0 ? `${path.join('.')}: ${issue.message}` : issue.message;
  });

const parseBody = (event: APIGatewayProxyEvent): { ok: true; body: unknown } | { ok: false } => {
  if (typeof event.body !== 'string' || event.body.length === 0) {
    return { ok: true, body: event.body ?? undefined };
  }
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

export const createApiHandler = <
  TSchema extends z.ZodType | undefined = undefined,
  TClients = DsqlClients,
>(
  fn: (
    event: ValidatedEvent<TSchema>,
    context: HandlerContext<TClients>,
  ) => Promise<HandlerResponse>,
  options: ApiHandlerOptions<TSchema, TClients> = {},
) => {
  const serviceName =
    options.serviceName ?? process.env['POWERTOOLS_SERVICE_NAME'] ?? 'exchange-api';
  const logger = options.logger ?? new Logger({ serviceName });
  const tracer = options.tracer ?? new Tracer({ serviceName });
  const dsql = (options.dsqlClients ?? {}) as TClients;

  return async (
    rawEvent: APIGatewayProxyEvent,
    lambdaContext: Context,
  ): Promise<APIGatewayProxyResult> => {
    const requestId = rawEvent.requestContext?.requestId ?? lambdaContext.awsRequestId;
    logger.addContext(lambdaContext);
    logger.appendKeys({ requestId });

    const parentSegment = tracer.getSegment();
    const subsegment = parentSegment?.addNewSubsegment(`## ${serviceName}`);
    if (subsegment) {
      tracer.setSegment(subsegment);
      tracer.annotateColdStart();
      tracer.addServiceNameAnnotation();
    }

    try {
      const parsed = parseBody(rawEvent);
      if (!parsed.ok) {
        logger.warn('Request body is not valid JSON');
        return errorResponse(400, {
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON',
          requestId,
        });
      }
      const event: ParsedEvent = { ...rawEvent, body: parsed.body };

      let validated: unknown = event;
      if (options.zodRequestValidator) {
        const result = options.zodRequestValidator.safeParse(event);
        if (!result.success) {
          const details = describeEventIssues(result.error);
          logger.warn('Request validation failed', { details });
          return errorResponse(400, {
            code: 'BAD_REQUEST',
            message: 'Invalid request',
            details,
            requestId,
          });
        }
        validated = result.data;
      }

      const result = await fn(validated as ValidatedEvent<TSchema>, {
        logger,
        tracer,
        dsql,
        withRetry,
        runInTransaction,
        lambdaContext,
        requestId,
      });

      const body =
        options.sanitise === false || result.body === undefined
          ? result.body
          : sanitiseResponse(result.body);
      if (options.captureResponse && subsegment && body !== undefined) {
        subsegment.addMetadata('response', body, serviceName);
      }
      return {
        statusCode: result.statusCode,
        headers: { 'Content-Type': 'application/json', ...result.headers },
        body: body === undefined ? '' : JSON.stringify(body),
      };
    } catch (error) {
      // An HttpError is an expected outcome, not a fault worth tracing.
      if (!(error instanceof HttpError) && error instanceof Error) {
        tracer.addErrorAsMetadata(error);
      }
      return mapErrorToHttpResponse(error, logger, requestId);
    } finally {
      logger.removeKeys(['requestId']);
      if (subsegment && parentSegment) {
        subsegment.close();
        tracer.setSegment(parentSegment);
      }
    }
  };
};
