import { beforeEach, describe, expect, test } from 'vitest';
import { runInTransaction } from '../dsql-clients.js';
import {
  DELETE_ANCHOR_SQL,
  DELETE_LINKS_SQL,
  LOCK_ANCHOR_SQL,
  unlinkIdentifier,
} from './unlink-identifier.query.js';
import { FakeLinkStore, type LinkRow } from './unlink-identifier.testing.js';

const APP_ID = '11111111-1111-4111-8111-111111111111';
const IDX_ID = '22222222-2222-4222-8222-222222222222';
const DVLA_ID = '33333333-3333-4333-8333-333333333333';
const HMRC_ID = '44444444-4444-4444-8444-444444444444';

const row = (id: string, fields: Partial<LinkRow>): LinkRow => ({
  id,
  domain: 'app',
  domain_id: APP_ID,
  linked_domain: 'dvla',
  linked_domain_id: DVLA_ID,
  scope: null,
  scope_id: null,
  idx_id: IDX_ID,
  ...fields,
});

const anchor = row('anchor', { linked_domain: 'IdX', linked_domain_id: IDX_ID, idx_id: null });
const dvla = row('dvla-link', {});
const hmrc = row('hmrc-link', { linked_domain: 'hmrc', linked_domain_id: HMRC_ID });

let store: FakeLinkStore;
const unlink = (input: Partial<Parameters<typeof unlinkIdentifier>[1]> = {}) =>
  runInTransaction(store.pool, (tx) =>
    unlinkIdentifier(tx, { domain: 'app', domainId: APP_ID, linkedDomain: 'dvla', ...input }),
  );

beforeEach(() => {
  store = new FakeLinkStore();
});

describe('unlinkIdentifier', () => {
  test('removes the link and its attributes, keeping the anchor while other links remain', async () => {
    store.links = [anchor, dvla, hmrc];
    store.attributes = [
      { id: 'a1', linked_identifier_id: 'dvla-link', name: 'licence' },
      { id: 'a2', linked_identifier_id: 'hmrc-link', name: 'utr' },
    ];

    const result = await unlink({ linkedDomainId: DVLA_ID });

    expect(result).toEqual({ removedLinkIds: ['dvla-link'], anchorDeleted: false });
    expect(store.links.map(({ id }) => id)).toEqual(['anchor', 'hmrc-link']);
    expect(store.attributes.map(({ id }) => id)).toEqual(['a2']);
    expect(store.statementNames()).toEqual([
      'BEGIN',
      'LOCK_ANCHOR',
      'DELETE_LINKS',
      'REMAINING_LINK',
      'DELETE_ATTRIBUTES',
      'COMMIT',
    ]);
  });

  test('removes the anchor (and any attributes on it) with its last link', async () => {
    store.links = [anchor, dvla];
    store.attributes = [
      { id: 'a1', linked_identifier_id: 'dvla-link', name: 'licence' },
      { id: 'a2', linked_identifier_id: 'anchor', name: 'note' },
    ];

    const result = await unlink();

    expect(result).toEqual({ removedLinkIds: ['dvla-link'], anchorDeleted: true });
    expect(store.links).toEqual([]);
    expect(store.attributes).toEqual([]);
    expect(store.statements.find(({ sql }) => sql === DELETE_ANCHOR_SQL.trim())?.params).toEqual([
      'anchor',
    ]);
  });

  test('deletes nothing else when no link matches', async () => {
    store.links = [anchor, hmrc];

    const result = await unlink();

    expect(result).toEqual({ removedLinkIds: [], anchorDeleted: false });
    expect(store.links).toEqual([anchor, hmrc]);
    expect(store.statementNames()).toEqual(['BEGIN', 'LOCK_ANCHOR', 'DELETE_LINKS', 'COMMIT']);
  });

  test('is idempotent: a second unlink finds nothing', async () => {
    store.links = [anchor, dvla];

    await unlink();
    const second = await unlink();

    expect(second).toEqual({ removedLinkIds: [], anchorDeleted: false });
    expect(store.links).toEqual([]);
  });

  test('without linkedDomainId or scope, removes every link to the linked domain', async () => {
    const otherDvla = row('dvla-link-2', {
      linked_domain_id: HMRC_ID,
      scope: 'device',
      scope_id: 'd-1',
    });
    store.links = [anchor, dvla, otherDvla, hmrc];

    const result = await unlink();

    expect(result.removedLinkIds).toEqual(['dvla-link', 'dvla-link-2']);
    expect(store.links.map(({ id }) => id)).toEqual(['anchor', 'hmrc-link']);
  });

  test('a scope narrows the match', async () => {
    const scoped = row('scoped', { scope: 'device', scope_id: 'd-1' });
    const otherDevice = row('other-device', {
      linked_domain_id: HMRC_ID,
      scope: 'device',
      scope_id: 'd-2',
    });
    store.links = [anchor, dvla, scoped, otherDevice];

    const result = await unlink({ scope: 'device', scopeId: 'd-1' });

    expect(result).toEqual({ removedLinkIds: ['scoped'], anchorDeleted: false });
    expect(store.links.map(({ id }) => id)).toEqual(['anchor', 'dvla-link', 'other-device']);
  });

  test('keeps the anchor while a link from another domain still shares its idx_id', async () => {
    const web = row('web-link', { domain: 'web', linked_domain: 'udp' });
    store.links = [anchor, dvla, web];

    const result = await unlink();

    expect(result.anchorDeleted).toBe(false);
    expect(store.links.map(({ id }) => id)).toEqual(['anchor', 'web-link']);
  });

  test('a domain without an anchor just removes the link', async () => {
    const noAnchor = row('no-anchor', { domain: 'dvla', linked_domain: 'hmrc', idx_id: null });
    store.links = [noAnchor];

    const result = await unlink({ domain: 'dvla', linkedDomain: 'hmrc' });

    expect(result).toEqual({ removedLinkIds: ['no-anchor'], anchorDeleted: false });
    expect(store.statementNames()).not.toContain('REMAINING_LINK');
  });

  test('binds every value as a parameter, with NULL for an omitted filter', async () => {
    await unlink({ scope: 'device' });

    const lock = store.statements.find(({ sql }) => sql === LOCK_ANCHOR_SQL.trim());
    const del = store.statements.find(({ sql }) => sql === DELETE_LINKS_SQL.trim());
    expect(lock?.params).toEqual(['app', APP_ID]);
    expect(del?.params).toEqual(['app', APP_ID, 'dvla', null, 'device', null]);
  });

  test('locks the anchor row FOR UPDATE, and never deletes IdX rows as links', () => {
    expect(LOCK_ANCHOR_SQL).toMatch(/FOR UPDATE\s*$/);
    expect(DELETE_LINKS_SQL).toContain("linked_domain <> 'IdX'");
    expect(DELETE_ANCHOR_SQL).toContain("linked_domain = 'IdX'");
  });
});
