import { type Pool } from 'pg';
import { PostgresIdempotencyStore, postgresIdempotencyTableSql, type PostgresClientLike } from '../src';
import { FakePostgres } from './fake-postgres';
import { describeStoreContract } from './store-contract';

describeStoreContract('PostgresIdempotencyStore', () => new PostgresIdempotencyStore(new FakePostgres()));

describe('PostgresIdempotencyStore', () => {
  let db: FakePostgres;
  let store: PostgresIdempotencyStore;

  beforeEach(() => {
    db = new FakePostgres();
    store = new PostgresIdempotencyStore(db);
  });

  it('accepts a pg Pool', () => {
    const typed: ConstructorParameters<typeof PostgresIdempotencyStore>[0] = {} as Pool;
    expect(typed).toBeDefined();
  });

  it('claims a key with INSERT ... ON CONFLICT DO NOTHING in a single round trip', async () => {
    await store.acquire('abc', 'fp', 1000);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toMatch(/^INSERT INTO "idempotency_keys" .* ON CONFLICT \(key\) DO NOTHING/);
  });

  it('takes over an expired row without waiting for cleanup', async () => {
    let now = 0;
    db.now = () => now;
    const first = await store.acquire('abc', 'fp', 100);
    now = 100;
    const second = await store.acquire('abc', 'other', 1000);
    expect(second).toMatchObject({ acquired: true, lease: { fingerprint: 'other' } });
    if (!first.acquired) throw new Error('expected to acquire');
    await expect(store.release(first.lease)).resolves.toBe(false);
  });

  it('deletes only expired rows in deleteExpired()', async () => {
    let now = 0;
    db.now = () => now;
    await store.acquire('a', 'fp', 100);
    await store.acquire('b', 'fp', 500);
    now = 200;
    await expect(store.deleteExpired()).resolves.toBe(1);
    expect([...db.rows.keys()]).toEqual(['b']);
  });

  it('writes to a schema-qualified table', async () => {
    const billing = new PostgresIdempotencyStore(db, { tableName: 'billing.idempotency_keys' });
    await billing.acquire('abc', 'fp', 1000);
    expect(db.statements[0]).toContain('INSERT INTO "billing"."idempotency_keys"');
  });

  it('rejects table names that are not plain identifiers', () => {
    expect(() => new PostgresIdempotencyStore(db, { tableName: 'keys; DROP TABLE users' })).toThrow(
      /Invalid Postgres table name/,
    );
    expect(() => postgresIdempotencyTableSql('a.b.c')).toThrow(/optionally qualified by a schema/);
  });

  it('creates the table and its expiry index', async () => {
    await store.createTable();
    expect(db.statements[0]).toContain('CREATE TABLE IF NOT EXISTS "idempotency_keys"');
    expect(postgresIdempotencyTableSql('billing.keys')).toContain(
      'CREATE INDEX IF NOT EXISTS "keys_expires_at_idx" ON "billing"."keys" (expires_at);',
    );
  });

  it('reads responses from drivers that return json columns as strings', async () => {
    const response = { statusCode: 201, headers: {}, body: { id: 'pay_1' } };
    const client: PostgresClientLike = {
      query: (text) =>
        Promise.resolve(
          text.startsWith('SELECT')
            ? { rows: [{ status: 'completed', fingerprint: 'fp', response: JSON.stringify(response) }] }
            : { rows: [] },
        ),
    };
    await expect(new PostgresIdempotencyStore(client).acquire('abc', 'fp', 1000)).resolves.toEqual({
      acquired: false,
      record: { status: 'completed', fingerprint: 'fp', response },
    });
  });

  it('explains what to do when a row was not written by this store', async () => {
    const client: PostgresClientLike = {
      query: (text) =>
        Promise.resolve({ rows: text.startsWith('SELECT') ? [{ status: 'done', fingerprint: 'fp' }] : [] }),
    };
    await expect(new PostgresIdempotencyStore(client).acquire('abc', 'fp', 1000)).rejects.toThrow(
      /give this store its own tableName/,
    );
  });

  it('gives up with a clear error when the key keeps vanishing', async () => {
    const client: PostgresClientLike = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
    await expect(new PostgresIdempotencyStore(client).acquire('abc', 'fp', 1000)).rejects.toThrow(
      /Increase lockTtlSeconds/,
    );
  });
});
