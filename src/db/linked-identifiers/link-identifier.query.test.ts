import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { LINK_IDENTIFIER_SQL, linkIdentifier } from './link-identifier.query.js';

const schema = readFileSync(new URL('../schema/linked_identifiers.sql', import.meta.url), 'utf8');
const squash = (text: string) =>
  text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');

describe('LINK_IDENTIFIER_SQL', () => {
  test('mints anchors only for the anchoring domains', () => {
    expect(LINK_IDENTIFIER_SQL).toContain("WHERE $1::text IN ('app', 'web')");
  });

  // ON CONFLICT only infers a unique index whose columns (and predicate)
  // match exactly; otherwise Postgres errors at runtime.
  test('conflict targets match the unique indexes in the schema', () => {
    const sql = squash(LINK_IDENTIFIER_SQL);
    const indexes = squash(schema);

    expect(sql).toContain("ON CONFLICT (domain, domain_id) WHERE linked_domain = 'idx' DO NOTHING");
    expect(indexes).toContain("(domain, domain_id) WHERE linked_domain = 'IdX'");

    const linkColumns =
      "domain, domain_id, linked_domain, linked_domain_id, COALESCE(scope, ''), COALESCE(scope_id, '')";
    expect(sql).toContain(`ON CONFLICT (${linkColumns}) DO NOTHING`);
    expect(indexes).toContain(
      `idx_linked_identifiers_unique_link ON linked_identifiers (${linkColumns})`,
    );
  });
});

describe('linkIdentifier', () => {
  test('maps the row to the DTO and returns the created flag beside it', async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: 'l',
          domain: 'web',
          domain_id: 'd',
          linked_domain: 'hmrc',
          linked_domain_id: 'h',
          scope: null,
          scope_id: null,
          idx_id: null,
          created_at: '2026-11-27T12:00:00Z',
          created: false,
        },
      ],
    }));

    const result = await linkIdentifier(
      { query },
      { domain: 'web', domainId: 'd', linkedDomain: 'hmrc', linkedDomainId: 'h' },
      'minted',
    );

    expect(result).toEqual({
      created: false,
      link: expect.objectContaining({
        id: 'l',
        idxId: null,
        createdAt: '2026-11-27T12:00:00.000Z',
      }),
    });
    expect(result.link).not.toHaveProperty('created');
  });

  test('an empty result is a retryable serialization failure', async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await expect(
      linkIdentifier(
        { query },
        { domain: 'web', domainId: 'd', linkedDomain: 'hmrc', linkedDomainId: 'h' },
        'minted',
      ),
    ).rejects.toMatchObject({ code: '40001' });
  });
});
