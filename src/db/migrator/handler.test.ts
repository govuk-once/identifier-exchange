import { describe, expect, test } from 'vitest';
import { describeErrorChain } from './handler.js';

describe('describeErrorChain', () => {
  test('includes every cause, with error codes', () => {
    const socket = Object.assign(new Error('getaddrinfo ENOTFOUND abc.dsql.eu-west-2.on.aws'), {
      code: 'ENOTFOUND',
    });
    const query = new Error('Failed query: \n  CREATE TABLE x (\n  id INT\n)', { cause: socket });

    expect(describeErrorChain(query)).toBe(
      [
        'Error: Failed query: CREATE TABLE x ( id INT )',
        'caused by Error [ENOTFOUND]: getaddrinfo ENOTFOUND abc.dsql.eu-west-2.on.aws',
      ].join('\n'),
    );
  });

  test('lists each attempt of a multi-address connect failure', () => {
    const error = new AggregateError([new Error('connect ETIMEDOUT 1.2.3.4:5432')], '');

    expect(describeErrorChain(error)).toContain('- Error: connect ETIMEDOUT 1.2.3.4:5432');
  });

  test('handles non-Error values', () => {
    expect(describeErrorChain('boom')).toBe('boom');
  });
});
