import { describe, expect, test } from 'vitest';
import { sanitiseResponse } from './sanitise.js';

describe('sanitiseResponse', () => {
  test('converts Dates and bigints, recursively', () => {
    const input = {
      createdAt: new Date('2026-11-26T12:00:00Z'),
      nested: [{ id: 9007199254740993n }],
    };

    expect(sanitiseResponse(input)).toEqual({
      createdAt: '2026-11-26T12:00:00.000Z',
      nested: [{ id: '9007199254740993' }],
    });
  });

  test('drops undefined, functions and symbols as JSON.stringify would', () => {
    const input = { a: undefined, b: () => 1, c: Symbol('x'), d: null, e: [undefined, 1] };

    expect(sanitiseResponse(input)).toEqual({ d: null, e: [null, 1] });
  });

  test('leaves primitives and objects with toJSON alone, and does not modify the input', () => {
    const buffer = Buffer.from('x');
    const input = { buffer, n: 1, s: 's', t: true };

    expect(sanitiseResponse(input)).toEqual(input);
    expect((sanitiseResponse(input) as { buffer: unknown }).buffer).toBe(buffer);
    expect(sanitiseResponse('plain')).toBe('plain');
  });
});
