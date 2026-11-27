import type { QueryResultRow } from '../dsql-clients.js';
import { IDX_DOMAIN } from './linked-identifier.js';
import {
  DELETE_ANCHOR_SQL,
  DELETE_ATTRIBUTES_SQL,
  DELETE_LINKS_SQL,
  LOCK_ANCHOR_SQL,
  REMAINING_LINK_SQL,
} from './unlink-identifier.query.js';

// In-memory linked_identifiers and identifier_attributes for unlink tests.
// It runs the unlink query module's statements (matched by text) against
// rows, keeps BEGIN/ROLLBACK semantics, and can fail any statement, so
// tests cover the whole flow from the handler through runInTransaction.

export interface LinkRow {
  id: string;
  domain: string;
  domain_id: string;
  linked_domain: string;
  linked_domain_id: string;
  scope: string | null;
  scope_id: string | null;
  idx_id: string | null;
}

export interface AttributeRow {
  id: string;
  linked_identifier_id: string;
  name: string;
}

export type Failure = (sql: string, call: number) => Error | undefined;

/** A pg-style error, e.g. pgError('OC000') for a DSQL OCC conflict. */
export const pgError = (code: string, message = `pg error ${code}`) =>
  Object.assign(new Error(message), { code });

export class FakeLinkStore {
  links: LinkRow[] = [];
  attributes: AttributeRow[] = [];
  /** Every statement, trimmed, in order. */
  readonly statements: { sql: string; params: unknown[] }[] = [];
  /** Returns an error to throw instead of running the statement. */
  fail: Failure = () => undefined;
  releases = 0;
  private snapshot?: { links: LinkRow[]; attributes: AttributeRow[] } | undefined;

  readonly connection = {
    query: async (sql: string, params: unknown[] = []) => this.query(sql, params),
    release: () => {
      this.releases += 1;
    },
  };

  readonly pool = {
    query: async (sql: string, params: unknown[] = []) => this.query(sql, params),
    connect: async () => this.connection,
  };

  /** Short names of the statements run, e.g. ['BEGIN', 'LOCK_ANCHOR', ...]. */
  statementNames(): string[] {
    return this.statements.map(({ sql }) => NAMES.get(sql) ?? sql);
  }

  private async query(rawSql: string, params: unknown[]): Promise<{ rows: QueryResultRow[] }> {
    const sql = rawSql.trim();
    this.statements.push({ sql, params });
    const error = this.fail(sql, this.statements.length);
    if (error) {
      throw error;
    }
    return { rows: this.run(sql, params) as unknown as QueryResultRow[] };
  }

  private run(sql: string, params: unknown[]): unknown[] {
    switch (sql) {
      case 'BEGIN':
        this.snapshot = { links: [...this.links], attributes: [...this.attributes] };
        return [];
      case 'COMMIT':
        this.snapshot = undefined;
        return [];
      case 'ROLLBACK':
        if (this.snapshot) {
          ({ links: this.links, attributes: this.attributes } = this.snapshot);
        }
        this.snapshot = undefined;
        return [];
      case LOCK_ANCHOR_SQL.trim(): {
        const [domain, domainId] = params;
        return this.links
          .filter(
            (row) =>
              row.domain === domain &&
              row.domain_id === domainId &&
              row.linked_domain === IDX_DOMAIN,
          )
          .map(({ id, linked_domain_id }) => ({ id, linked_domain_id }));
      }
      case DELETE_LINKS_SQL.trim(): {
        const [domain, domainId, linkedDomain, linkedDomainId, scope, scopeId] = params;
        const matches = (row: LinkRow) =>
          row.domain === domain &&
          row.domain_id === domainId &&
          row.linked_domain === linkedDomain &&
          row.linked_domain !== IDX_DOMAIN &&
          (linkedDomainId === null || row.linked_domain_id === linkedDomainId) &&
          (scope === null || row.scope === scope) &&
          (scopeId === null || row.scope_id === scopeId);
        const deleted = this.links.filter(matches);
        this.links = this.links.filter((row) => !matches(row));
        return deleted.map(({ id, idx_id }) => ({ id, idx_id }));
      }
      case REMAINING_LINK_SQL.trim():
        return this.links.filter((row) => row.idx_id === params[0]).map(() => ({ '?column?': 1 }));
      case DELETE_ANCHOR_SQL.trim():
        this.links = this.links.filter(
          (row) => !(row.id === params[0] && row.linked_domain === IDX_DOMAIN),
        );
        return [];
      case DELETE_ATTRIBUTES_SQL.trim(): {
        const ids = new Set(params[0] as string[]);
        this.attributes = this.attributes.filter((row) => !ids.has(row.linked_identifier_id));
        return [];
      }
      default:
        throw new Error(`FakeLinkStore does not know: ${sql}`);
    }
  }
}

const NAMES = new Map([
  [LOCK_ANCHOR_SQL.trim(), 'LOCK_ANCHOR'],
  [DELETE_LINKS_SQL.trim(), 'DELETE_LINKS'],
  [REMAINING_LINK_SQL.trim(), 'REMAINING_LINK'],
  [DELETE_ANCHOR_SQL.trim(), 'DELETE_ANCHOR'],
  [DELETE_ATTRIBUTES_SQL.trim(), 'DELETE_ATTRIBUTES'],
]);
