import { describe, expect, test, vi } from 'vitest';
import {
  EXCHANGE_IDENTIFIER_SQL,
  type ExchangeIdentifierRowDSQL,
  decryptExchangedIdentifiers,
  findExchangedIdentifiers,
  toExchangedIdentifiers,
} from './exchange-identifier.query.js';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const DVLA_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const IDX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINK_1 = '0f0e0d0c-0b0a-4909-8807-060504030201';
const LINK_2 = '1f0e0d0c-0b0a-4909-8807-060504030201';

const row = (overrides: Partial<ExchangeIdentifierRowDSQL> = {}): ExchangeIdentifierRowDSQL => ({
  id: LINK_1,
  domain: 'App',
  domain_id: APP_ID,
  linked_domain: 'DVLA',
  linked_domain_id: DVLA_ID,
  scope: null,
  scope_id: null,
  idx_id: IDX_ID,
  created_at: new Date('2026-11-26T12:00:00Z'),
  exchanged_id: DVLA_ID,
  exchanged_domain: 'DVLA',
  attribute_id: null,
  attribute_name: null,
  attribute_value: null,
  attribute_data_key: null,
  attribute_created_at: null,
  ...overrides,
});

const attributeColumns = (id: string, name: string) => ({
  attribute_id: id,
  attribute_name: name,
  attribute_value: `enc-${name}`,
  attribute_data_key: `key-${name}`,
  attribute_created_at: '2026-11-26 12:30:00+00',
});

describe('EXCHANGE_IDENTIFIER_SQL', () => {
  test('resolves the group from either side of a link and from an IdX anchor', () => {
    const sql = EXCHANGE_IDENTIFIER_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain(
      '(domain = $1 AND domain_id = $2) OR (linked_domain = $1 AND linked_domain_id = $2)',
    );
    expect(sql).toContain(
      "SELECT linked_domain_id AS idx_id FROM linked_identifiers WHERE domain = $1 AND domain_id = $2 AND linked_domain = 'IdX'",
    );
  });

  test('matches the target domain on either side and resolves the exchanged ID from it', () => {
    const sql = EXCHANGE_IDENTIFIER_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('WHERE (li.linked_domain = $3 OR li.domain = $3)');
    expect(sql).toContain(
      'WHEN li.linked_domain = $3 THEN li.linked_domain_id WHEN li.domain = $3 THEN li.domain_id',
    );
  });
});

describe('toExchangedIdentifiers', () => {
  test('maps a link with no attributes to a camelCase DTO with an empty attribute list', () => {
    expect(toExchangedIdentifiers([row()])).toEqual([
      {
        id: LINK_1,
        domain: 'App',
        domainId: APP_ID,
        linkedDomain: 'DVLA',
        linkedDomainId: DVLA_ID,
        scope: null,
        scopeId: null,
        idxId: IDX_ID,
        createdAt: '2026-11-26T12:00:00.000Z',
        exchangedId: DVLA_ID,
        exchangedDomain: 'DVLA',
        attributes: [],
      },
    ]);
  });

  test('folds one row per attribute into one DTO per link, keeping query order', () => {
    const links = toExchangedIdentifiers([
      row({ id: LINK_2, ...attributeColumns('a1', 'att1') }),
      row({ id: LINK_2, ...attributeColumns('a2', 'att2') }),
      row({ id: LINK_1 }),
    ]);

    expect(links.map((l) => l.id)).toEqual([LINK_2, LINK_1]);
    expect(links[0]?.attributes).toEqual([
      {
        id: 'a1',
        linkedIdentifierId: LINK_2,
        name: 'att1',
        value: 'enc-att1',
        dataKey: 'key-att1',
        createdAt: '2026-11-26T12:30:00.000Z',
      },
      expect.objectContaining({ id: 'a2', name: 'att2' }),
    ]);
    expect(links[1]?.attributes).toEqual([]);
  });

  test('returns nothing for no rows', () => {
    expect(toExchangedIdentifiers([])).toEqual([]);
  });
});

describe('findExchangedIdentifiers', () => {
  test('binds caller domain, caller ID and target domain as $1, $2, $3', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ ...row() }],
    }));

    const links = await findExchangedIdentifiers(
      { query },
      { domain: 'App', domainId: APP_ID, linkedDomain: 'DVLA' },
    );

    expect(query).toHaveBeenCalledWith(EXCHANGE_IDENTIFIER_SQL, ['App', APP_ID, 'DVLA']);
    expect(links).toHaveLength(1);
  });
});

describe('decryptExchangedIdentifiers', () => {
  test('replaces ciphertext with plaintext and drops the data key', async () => {
    const [link] = toExchangedIdentifiers([row(attributeColumns('a1', 'att1'))]);
    const decrypt = vi.fn(async ({ value }: { value: string }) => value.replace('enc-', 'plain-'));

    const [decrypted] = await decryptExchangedIdentifiers(link ? [link] : [], decrypt);

    expect(decrypt).toHaveBeenCalledWith(
      expect.objectContaining({ linkedIdentifierId: LINK_1, name: 'att1', dataKey: 'key-att1' }),
    );
    expect(decrypted?.attributes).toEqual([
      { id: 'a1', name: 'att1', value: 'plain-att1', createdAt: '2026-11-26T12:30:00.000Z' },
    ]);
  });

  test('fails if any attribute fails to decrypt', async () => {
    const links = toExchangedIdentifiers([row(attributeColumns('a1', 'att1'))]);

    await expect(
      decryptExchangedIdentifiers(links, async () => {
        throw new Error('InvalidCiphertextException');
      }),
    ).rejects.toThrow('InvalidCiphertextException');
  });
});
