import { describe, expect, test } from 'vitest';
import { type LinkedIdentifierDSQL, toLinkedIdentifier } from './linked-identifier.js';

const APP_ID = '11111111-1111-1111-1111-111111111111';
const IDX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DVLA_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const row = (overrides: Partial<LinkedIdentifierDSQL> = {}): LinkedIdentifierDSQL => ({
  id: '0f0e0d0c-0b0a-4909-8807-060504030201',
  domain: 'App',
  domain_id: APP_ID,
  linked_domain: 'DVLA',
  linked_domain_id: DVLA_ID,
  scope: 'device',
  scope_id: 'device-1234',
  idx_id: IDX_ID,
  created_at: new Date('2026-11-26T14:19:27.123Z'),
  ...overrides,
});

describe('toLinkedIdentifier', () => {
  test('maps every snake_case column to its camelCase field', () => {
    expect(toLinkedIdentifier(row())).toEqual({
      id: '0f0e0d0c-0b0a-4909-8807-060504030201',
      domain: 'App',
      domainId: APP_ID,
      linkedDomain: 'DVLA',
      linkedDomainId: DVLA_ID,
      scope: 'device',
      scopeId: 'device-1234',
      idxId: IDX_ID,
      createdAt: '2026-11-26T14:19:27.123Z',
    });
  });

  test('keeps a null scope, scopeId and idxId as null (an IdX anchor row)', () => {
    const dto = toLinkedIdentifier(
      row({
        linked_domain: 'IdX',
        linked_domain_id: IDX_ID,
        scope: null,
        scope_id: null,
        idx_id: null,
      }),
    );

    expect(dto.scope).toBeNull();
    expect(dto.scopeId).toBeNull();
    expect(dto.idxId).toBeNull();
  });

  test('normalises a string created_at to ISO 8601 UTC', () => {
    const dto = toLinkedIdentifier(row({ created_at: '2026-11-26 14:19:27.123+00' }));

    expect(dto.createdAt).toBe('2026-11-26T14:19:27.123Z');
  });

  test('rejects an unparseable created_at', () => {
    expect(() => toLinkedIdentifier(row({ created_at: 'not a date' }))).toThrow(RangeError);
  });

  test('returns no snake_case keys', () => {
    expect(Object.keys(toLinkedIdentifier(row())).filter((key) => key.includes('_'))).toEqual([]);
  });
});
