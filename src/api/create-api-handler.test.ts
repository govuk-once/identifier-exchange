import type { Logger } from '@aws-lambda-powertools/logger';
import type { Tracer } from '@aws-lambda-powertools/tracer';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { type DsqlClients, runInTransaction, withRetry } from '../db/dsql-clients.js';
import {
  type ApiHandlerOptions,
  createApiHandler,
  type HandlerContext,
  type HandlerResponse,
  nullAsEmpty,
  type ValidatedEvent,
} from './create-api-handler.js';
import { apiErrorResponse } from './errors.js';
import { ConflictError, NotFoundError } from './http-errors.js';

const lambdaContext = { awsRequestId: 'aws-request-1', functionName: 'fn' } as Context;

const event = (overrides: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    body: null,
    headers: {},
    isBase64Encoded: false,
    pathParameters: null,
    queryStringParameters: null,
    requestContext: { requestId: 'request-1' },
    ...overrides,
  }) as APIGatewayProxyEvent;

const fakeLogger = () =>
  ({
    addContext: vi.fn(),
    appendKeys: vi.fn(),
    removeKeys: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger &
    Record<'addContext' | 'warn' | 'error' | 'removeKeys', ReturnType<typeof vi.fn>>;

const fakeTracer = () => {
  const subsegment = { addMetadata: vi.fn(), close: vi.fn() };
  const parentSegment = { addNewSubsegment: vi.fn(() => subsegment) };
  const tracer = {
    getSegment: vi.fn(() => parentSegment),
    setSegment: vi.fn(),
    annotateColdStart: vi.fn(),
    addServiceNameAnnotation: vi.fn(),
    addErrorAsMetadata: vi.fn(),
    putAnnotation: vi.fn(),
  };
  return { tracer, parentSegment, subsegment };
};

const parseBody = (result: { body: string }) => JSON.parse(result.body) as unknown;

let logger: ReturnType<typeof fakeLogger>;
let trace: ReturnType<typeof fakeTracer>;

beforeEach(() => {
  logger = fakeLogger();
  trace = fakeTracer();
});

const build = <S extends z.ZodType | undefined = undefined, C = DsqlClients>(
  fn: (event: ValidatedEvent<S>, context: HandlerContext<C>) => Promise<HandlerResponse>,
  options: ApiHandlerOptions<S, C> = {},
) =>
  createApiHandler<S, C>(fn, {
    serviceName: 'test-service',
    ...options,
    logger,
    tracer: trace.tracer as unknown as Tracer,
  });

const bodySchema = z.looseObject({
  body: z.object({ identityId: z.uuid(), count: z.number().int() }),
  pathParameters: nullAsEmpty(z.object({ id: z.string().min(3) })),
});

const IDENTITY_ID = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

describe('createApiHandler', () => {
  test('passes the parsed, validated event and a handler context, and serialises the response', async () => {
    const fn = vi.fn(async (): Promise<HandlerResponse> => ({
      statusCode: 201,
      body: { data: { ok: true } },
      headers: { 'X-Extra': 'yes' },
    }));
    const dsqlClients = { readClient: { query: vi.fn(), connect: vi.fn() } };
    const handler = build(fn, { zodRequestValidator: bodySchema, dsqlClients });

    const result = await handler(
      event({
        body: JSON.stringify({ identityId: IDENTITY_ID, count: 2 }),
        pathParameters: { id: 'abc' },
      }),
      lambdaContext,
    );

    expect(result).toEqual({
      statusCode: 201,
      headers: { 'Content-Type': 'application/json', 'X-Extra': 'yes' },
      body: JSON.stringify({ data: { ok: true } }),
    });
    const [validated, context] = fn.mock.calls[0] as unknown as [
      z.output<typeof bodySchema>,
      Record<string, unknown>,
    ];
    expect(validated.body).toEqual({ identityId: IDENTITY_ID, count: 2 });
    expect(validated.pathParameters).toEqual({ id: 'abc' });
    // looseObject keeps the rest of the event.
    expect(validated['requestContext']).toEqual({ requestId: 'request-1' });
    expect(context).toMatchObject({
      logger,
      tracer: trace.tracer,
      dsql: dsqlClients,
      withRetry,
      runInTransaction,
      lambdaContext,
      requestId: 'request-1',
    });
    expect(logger.addContext).toHaveBeenCalledWith(lambdaContext);
  });

  test('decodes a base64-encoded JSON body', async () => {
    const fn = vi.fn(async (): Promise<HandlerResponse> => ({ statusCode: 204 }));
    const handler = build(fn);

    const result = await handler(
      event({ body: Buffer.from('{"a":1}').toString('base64'), isBase64Encoded: true }),
      lambdaContext,
    );

    expect((fn.mock.calls[0] as unknown as [{ body: unknown }])[0].body).toEqual({ a: 1 });
    expect(result).toEqual({
      statusCode: 204,
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
  });

  test('passes the raw event, with body undefined, when there is no body or schema', async () => {
    const fn = vi.fn(async (): Promise<HandlerResponse> => ({ statusCode: 200, body: [] }));

    await build(fn)(event(), lambdaContext);

    expect((fn.mock.calls[0] as unknown[])[0]).toMatchObject({
      body: undefined,
      requestContext: { requestId: 'request-1' },
    });
  });

  test('returns 400 for malformed JSON without calling the handler', async () => {
    const fn = vi.fn();
    const result = await build(fn)(event({ body: '{not json' }), lambdaContext);

    expect(fn).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(400);
    expect(apiErrorResponse.parse(parseBody(result))).toEqual({
      code: 'INVALID_JSON',
      message: 'Request body is not valid JSON',
      requestId: 'request-1',
    });
  });

  test('returns 400 with one detail per Zod issue, without the event location', async () => {
    const fn = vi.fn();
    const handler = build(fn, { zodRequestValidator: bodySchema });

    const result = await handler(
      event({ body: JSON.stringify({ identityId: 'nope', count: 1.5 }), pathParameters: null }),
      lambdaContext,
    );

    expect(fn).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(400);
    const body = apiErrorResponse.parse(parseBody(result));
    expect(body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Invalid request',
      requestId: 'request-1',
    });
    expect(body.details).toEqual([
      expect.stringMatching(/^identityId: /),
      expect.stringMatching(/^count: /),
      expect.stringMatching(/^id: /),
    ]);
    expect(logger.warn).toHaveBeenCalledWith('Request validation failed', {
      details: body.details,
    });
  });

  test.each([
    [
      new NotFoundError('LINK_NOT_FOUND', 'Linked identity record not found'),
      404,
      'LINK_NOT_FOUND',
    ],
    [new ConflictError(), 409, 'CONFLICT'],
  ])('maps a thrown %s to its status and code', async (error, statusCode, code) => {
    const result = await build(async () => {
      throw error;
    })(event(), lambdaContext);

    expect(result.statusCode).toBe(statusCode);
    expect(apiErrorResponse.parse(parseBody(result))).toEqual({
      code,
      message: error.message,
      requestId: 'request-1',
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(trace.tracer.addErrorAsMetadata).not.toHaveBeenCalled();
  });

  test('maps an unhandled error to a generic 500 and records it on the trace', async () => {
    const error = new Error('secret connection string in here');
    const result = await build(async () => {
      throw error;
    })(event(), lambdaContext);

    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret');
    expect(apiErrorResponse.parse(parseBody(result))).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      requestId: 'request-1',
    });
    expect(logger.error).toHaveBeenCalledWith('Unhandled error', { error });
    expect(trace.tracer.addErrorAsMetadata).toHaveBeenCalledWith(error);
  });

  test('sanitises the body unless told not to', async () => {
    const createdAt = new Date('2026-11-26T12:00:00Z');
    const fn = async (): Promise<HandlerResponse> => ({
      statusCode: 200,
      body: { createdAt, id: 10n, gone: undefined },
    });

    const sanitised = await build(fn)(event(), lambdaContext);
    expect(parseBody(sanitised)).toEqual({ createdAt: '2026-11-26T12:00:00.000Z', id: '10' });

    const raw = await build(async () => ({ statusCode: 200, body: { createdAt } }), {
      sanitise: false,
    })(event(), lambdaContext);
    expect(parseBody(raw)).toEqual({ createdAt: '2026-11-26T12:00:00.000Z' });
  });

  describe('X-Ray', () => {
    test('opens a subsegment for the invocation and restores the parent afterwards', async () => {
      await build(async () => ({ statusCode: 200, body: { a: 1 } }))(event(), lambdaContext);

      expect(trace.parentSegment.addNewSubsegment).toHaveBeenCalledWith('## test-service');
      expect(trace.tracer.setSegment.mock.calls).toEqual([
        [trace.subsegment],
        [trace.parentSegment],
      ]);
      expect(trace.tracer.annotateColdStart).toHaveBeenCalled();
      expect(trace.subsegment.close).toHaveBeenCalledOnce();
      expect(trace.subsegment.addMetadata).not.toHaveBeenCalled();
    });

    test.each([
      ['an unhandled error', { body: null }, new Error('boom')],
      ['an HttpError', { body: null }, new NotFoundError()],
      ['malformed JSON', { body: '{' }, undefined],
    ])('closes the subsegment after %s', async (_name, overrides, error) => {
      await build(async () => {
        if (error) throw error;
        return { statusCode: 200 };
      })(event(overrides), lambdaContext);

      expect(trace.subsegment.close).toHaveBeenCalledOnce();
      expect(trace.tracer.setSegment).toHaveBeenLastCalledWith(trace.parentSegment);
      expect(logger.removeKeys).toHaveBeenCalledWith(['requestId']);
    });

    test('adds the response as metadata only when captureResponse is set', async () => {
      await build(async () => ({ statusCode: 200, body: { a: 1 } }), { captureResponse: true })(
        event(),
        lambdaContext,
      );

      expect(trace.subsegment.addMetadata).toHaveBeenCalledWith(
        'response',
        { a: 1 },
        'test-service',
      );
    });

    test('works when there is no segment (tracing off)', async () => {
      trace.tracer.getSegment.mockReturnValue(undefined as never);

      const result = await build(async () => ({ statusCode: 200 }))(event(), lambdaContext);

      expect(result.statusCode).toBe(200);
      expect(trace.tracer.setSegment).not.toHaveBeenCalled();
    });
  });
});
