import { randomUUID } from 'node:crypto';
import {
  type AcquireResult,
  type IdempotencyLease,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency-store.interface';

/**
 * The subset of a `pg` client this store uses. A `pg` `Pool` satisfies it,
 * so `pg` stays an optional peer; wrap any other driver in a `query` method
 * that returns `{ rows, rowCount }`.
 *
 * Pass a pool rather than a client inside an open transaction: expiry uses
 * `now()`, which Postgres freezes at the start of a transaction.
 */
export interface PostgresClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export interface PostgresIdempotencyStoreOptions {
  /** Table holding the records, optionally schema-qualified. Defaults to `idempotency_keys`. */
  tableName?: string;
}

export const DEFAULT_POSTGRES_TABLE = 'idempotency_keys';

/** A lock can expire between a failed insert and the select that follows it. */
const MAX_ACQUIRE_ATTEMPTS = 3;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Statements {
  insertLock: string;
  selectLive: string;
  deleteExpiredKey: string;
  complete: string;
  release: string;
  deleteExpired: string;
}

/**
 * The DDL for the table `PostgresIdempotencyStore` expects. Run it in a
 * migration, or call `store.createTable()` once at startup.
 *
 * The response is a `json` column rather than `jsonb` so a replayed body
 * keeps the key order the handler produced.
 */
export function postgresIdempotencyTableSql(tableName: string = DEFAULT_POSTGRES_TABLE): string {
  const table = quoteTableName(tableName);
  const index = quoteIdentifier(`${tableName.split('.').pop()}_expires_at_idx`);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  key text PRIMARY KEY,',
    '  fingerprint text NOT NULL,',
    "  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),",
    '  token text,',
    '  response json,',
    '  expires_at timestamptz NOT NULL',
    ');',
    `CREATE INDEX IF NOT EXISTS ${index} ON ${table} (expires_at);`,
  ].join('\n');
}

/**
 * A store backed by a Postgres table, safe to share between any number of
 * processes.
 *
 * Locks are taken with `INSERT ... ON CONFLICT (key) DO NOTHING`, so the
 * primary key decides which of several concurrent requests wins. Completing
 * or releasing a lock is an `UPDATE` or `DELETE` conditioned on the caller's
 * token and on the lock not having expired, which gives the same guarantee
 * as the Redis store: a request whose lock expired can never overwrite the
 * record of the request that took over the key.
 *
 * Postgres does not expire rows by itself. Expired rows are ignored and are
 * replaced the next time their key is used; call `deleteExpired()` on a
 * schedule to keep the table small.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly tableName: string;
  private readonly sql: Statements;

  constructor(
    private readonly client: PostgresClientLike,
    options: PostgresIdempotencyStoreOptions = {},
  ) {
    this.tableName = options.tableName ?? DEFAULT_POSTGRES_TABLE;
    this.sql = buildStatements(quoteTableName(this.tableName));
  }

  async acquire(key: string, fingerprint: string, lockTtlMs: number): Promise<AcquireResult> {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const lease: IdempotencyLease = { key, token: randomUUID(), fingerprint };
      const inserted = await this.client.query(this.sql.insertLock, [key, fingerprint, lease.token, toMs(lockTtlMs)]);
      if (inserted.rows.length === 1) {
        return { acquired: true, lease };
      }
      const existing = await this.client.query(this.sql.selectLive, [key]);
      if (existing.rows.length > 0) {
        return { acquired: false, record: decodeRow(existing.rows[0], this.tableName) };
      }
      await this.client.query(this.sql.deleteExpiredKey, [key]);
    }
    throw new Error(
      `Could not acquire idempotency key "${key}" in table "${this.tableName}" after ${MAX_ACQUIRE_ATTEMPTS} attempts; ` +
        'locks are expiring faster than Postgres can be read. Increase lockTtlSeconds.',
    );
  }

  async complete(lease: IdempotencyLease, response: StoredResponse, ttlMs: number): Promise<boolean> {
    const result = await this.client.query(this.sql.complete, [
      lease.key,
      lease.token,
      JSON.stringify(response),
      toMs(ttlMs),
    ]);
    return result.rowCount === 1;
  }

  async release(lease: IdempotencyLease): Promise<boolean> {
    const result = await this.client.query(this.sql.release, [lease.key, lease.token]);
    return result.rowCount === 1;
  }

  /** Create the table and its expiry index if they do not exist. */
  async createTable(): Promise<void> {
    await this.client.query(postgresIdempotencyTableSql(this.tableName));
  }

  /** Delete every expired record and return how many were removed. Run it on a schedule. */
  async deleteExpired(): Promise<number> {
    const result = await this.client.query(this.sql.deleteExpired);
    return result.rowCount ?? 0;
  }
}

function buildStatements(table: string): Statements {
  const live = 'expires_at > now()';
  return {
    insertLock:
      `INSERT INTO ${table} (key, fingerprint, status, token, expires_at) ` +
      "VALUES ($1, $2, 'in_progress', $3, now() + $4::double precision * interval '1 millisecond') " +
      'ON CONFLICT (key) DO NOTHING RETURNING key',
    selectLive: `SELECT status, fingerprint, response FROM ${table} WHERE key = $1 AND ${live}`,
    deleteExpiredKey: `DELETE FROM ${table} WHERE key = $1 AND expires_at <= now()`,
    complete:
      `UPDATE ${table} SET status = 'completed', token = NULL, response = $3::json, ` +
      "expires_at = now() + $4::double precision * interval '1 millisecond' " +
      `WHERE key = $1 AND token = $2 AND status = 'in_progress' AND ${live}`,
    release: `DELETE FROM ${table} WHERE key = $1 AND token = $2 AND status = 'in_progress' AND ${live}`,
    deleteExpired: `DELETE FROM ${table} WHERE expires_at <= now()`,
  };
}

function decodeRow(row: unknown, tableName: string): IdempotencyRecord {
  if (isObject(row) && typeof row.fingerprint === 'string') {
    if (row.status === 'in_progress') {
      return { status: 'in_progress', fingerprint: row.fingerprint };
    }
    const response = typeof row.response === 'string' ? parseJson(row.response) : row.response;
    if (row.status === 'completed' && isObject(response)) {
      return { status: 'completed', fingerprint: row.fingerprint, response: response as unknown as StoredResponse };
    }
  }
  throw new Error(
    `Table "${tableName}" holds a row that is not an idempotency record. ` +
      'Another application may be writing to it; give this store its own tableName.',
  );
}

function quoteTableName(tableName: string): string {
  const parts = tableName.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new Error(
      `Invalid Postgres table name "${tableName}". Use letters, digits and underscores, ` +
        'optionally qualified by a schema, for example "billing.idempotency_keys".',
    );
  }
  return parts.map(quoteIdentifier).join('.');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toMs(value: number): number {
  return Math.max(1, Math.ceil(value));
}
