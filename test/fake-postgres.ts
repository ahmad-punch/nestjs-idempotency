import { type PostgresClientLike } from '../src';

interface Row {
  key: string;
  fingerprint: string;
  status: 'in_progress' | 'completed';
  token: string | null;
  response: string | null;
  expiresAt: number;
}

type QueryResult = { rows: unknown[]; rowCount: number };

/**
 * An in-process stand-in for a `pg` Pool that understands the statements
 * `PostgresIdempotencyStore` issues. It keeps the semantics that matter:
 * `ON CONFLICT DO NOTHING` sees every row with the key, live or expired,
 * while reads and conditional writes ignore expired rows. Every query yields
 * to the event loop first, so concurrent callers interleave as they would
 * against a real server. Unknown statements throw, so a change to the SQL
 * fails the tests until this fake is taught about it.
 */
export class FakePostgres implements PostgresClientLike {
  readonly rows = new Map<string, Row>();
  readonly statements: string[] = [];
  now: () => number = Date.now;

  async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    await new Promise((resolve) => setImmediate(resolve));
    const sql = text.replace(/\s+/g, ' ').trim();
    this.statements.push(sql);
    return this.execute(sql, values);
  }

  private execute(sql: string, values: unknown[]): QueryResult {
    if (sql.startsWith('CREATE TABLE')) {
      return result([]);
    }
    if (sql.startsWith('INSERT') && sql.includes('ON CONFLICT (key) DO NOTHING')) {
      return this.insertLock(values);
    }
    if (sql.startsWith('SELECT')) {
      return this.selectLive(String(values[0]));
    }
    if (sql.startsWith('UPDATE')) {
      return this.complete(values);
    }
    if (sql.startsWith('DELETE') && sql.includes('token = $2')) {
      return this.release(String(values[0]), String(values[1]));
    }
    if (sql.startsWith('DELETE') && sql.includes('key = $1')) {
      return this.deleteExpired((row) => row.key === values[0]);
    }
    if (sql.startsWith('DELETE')) {
      return this.deleteExpired(() => true);
    }
    throw new Error(`FakePostgres does not understand: ${sql}`);
  }

  private insertLock([key, fingerprint, token, ttlMs]: unknown[]): QueryResult {
    if (this.rows.has(String(key))) {
      return result([]);
    }
    this.rows.set(String(key), {
      key: String(key),
      fingerprint: String(fingerprint),
      status: 'in_progress',
      token: String(token),
      response: null,
      expiresAt: this.now() + Number(ttlMs),
    });
    return result([{ key }]);
  }

  private selectLive(key: string): QueryResult {
    const row = this.liveRow(key);
    if (!row) {
      return result([]);
    }
    const response: unknown = row.response === null ? null : JSON.parse(row.response);
    return result([{ status: row.status, fingerprint: row.fingerprint, response }]);
  }

  private complete([key, token, response, ttlMs]: unknown[]): QueryResult {
    const row = this.ownedLock(String(key), String(token));
    if (!row) {
      return result([], 0);
    }
    Object.assign(row, {
      status: 'completed',
      token: null,
      response: String(response),
      expiresAt: this.now() + Number(ttlMs),
    });
    return result([], 1);
  }

  private release(key: string, token: string): QueryResult {
    if (!this.ownedLock(key, token)) {
      return result([], 0);
    }
    this.rows.delete(key);
    return result([], 1);
  }

  private deleteExpired(matches: (row: Row) => boolean): QueryResult {
    let removed = 0;
    for (const row of [...this.rows.values()]) {
      if (matches(row) && row.expiresAt <= this.now()) {
        this.rows.delete(row.key);
        removed++;
      }
    }
    return result([], removed);
  }

  private ownedLock(key: string, token: string): Row | undefined {
    const row = this.liveRow(key);
    return row?.status === 'in_progress' && row.token === token ? row : undefined;
  }

  private liveRow(key: string): Row | undefined {
    const row = this.rows.get(key);
    return row && row.expiresAt > this.now() ? row : undefined;
  }
}

function result(rows: unknown[], rowCount: number = rows.length): QueryResult {
  return { rows, rowCount };
}
