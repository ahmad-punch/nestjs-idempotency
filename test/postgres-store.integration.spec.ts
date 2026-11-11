import { Pool } from 'pg';
import { PostgresIdempotencyStore } from '../src';
import { describeStoreContract } from './store-contract';

/**
 * Runs against a real server when POSTGRES_URL is set, for example
 * `POSTGRES_URL=postgres://localhost/idempotency_test pnpm test`.
 * Each run uses its own table and drops it afterwards.
 */
const url = process.env.POSTGRES_URL;
const describeWithPostgres = url ? describe : describe.skip;

describeWithPostgres('PostgresIdempotencyStore against a real server', () => {
  const tableName = `idempotency_test_${process.pid}`;
  let pool: Pool;
  let store: PostgresIdempotencyStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 10 });
    store = new PostgresIdempotencyStore(pool, { tableName });
    await store.createTable();
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE "${tableName}"`);
  });

  describeStoreContract('PostgresIdempotencyStore (pg)', () => store);

  it('replays a body with the key order the handler produced', async () => {
    const lease = await store.acquire('order', 'fp', 1000);
    if (!lease.acquired) throw new Error('expected to acquire');
    const body = { zeta: 1, alpha: { second: 2, first: 1 } };
    await store.complete(lease.lease, { statusCode: 201, headers: {}, body }, 1000);
    const replay = await store.acquire('order', 'fp', 1000);
    if (replay.acquired || replay.record.status !== 'completed') throw new Error('expected a completed record');
    expect(JSON.stringify(replay.record.response.body)).toBe(JSON.stringify(body));
  });

  it('removes expired rows with deleteExpired()', async () => {
    await store.acquire('short', 'fp', 20);
    await store.acquire('long', 'fp', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(store.deleteExpired()).resolves.toBe(1);
    const { rows } = await pool.query<{ key: string }>(`SELECT key FROM "${tableName}"`);
    expect(rows).toEqual([{ key: 'long' }]);
  });

  it('can create the table more than once', async () => {
    await expect(store.createTable()).resolves.toBeUndefined();
  });
});
