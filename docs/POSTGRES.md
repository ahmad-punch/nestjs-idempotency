# Postgres store

`PostgresIdempotencyStore` keeps idempotency records in one Postgres table. It needs only an object with a `pg`-style `query(text, values)` method, so `pg` is an optional peer dependency: pass a `Pool` and the library never imports `pg` itself.

```ts
import { Pool } from 'pg';
import { IdempotencyModule, PostgresIdempotencyStore } from 'nestjs-idempotency';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

IdempotencyModule.forRoot({
  store: new PostgresIdempotencyStore(pool, { tableName: 'idempotency_keys' }),
});
```

Pass a pool, not a client inside an open transaction. Expiry is computed with `now()`, which Postgres freezes at the start of a transaction, and a long transaction would also hold the row locks that decide which request wins a key.

## Table

Add this to a migration. `postgresIdempotencyTableSql(tableName)` returns the same SQL for any table name, and `store.createTable()` runs it with `IF NOT EXISTS`, which is convenient in development and tests.

```sql
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  token text,
  response json,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" (expires_at);
```

`key` is a SHA-256 of the scope and the client's key, so it is always 64 hex characters. `response` is `json` rather than `jsonb` on purpose: `jsonb` reorders object keys, and a replayed body should be byte-for-byte what the first request returned. The table name may be schema-qualified (`billing.idempotency_keys`).

## How it maps to the Redis store

| Step | Redis | Postgres |
| --- | --- | --- |
| Claim a key | `SET key lock PX ttl NX` | `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key` |
| Read the existing record | `GET key` | `SELECT ... WHERE key = $1 AND expires_at > now()` |
| Expired lock or record | Redis deletes it | Ignored by every read and write; deleted and retried on the next claim |
| Complete | Lua compare-and-set on the lock value | `UPDATE ... WHERE key = $1 AND token = $2 AND status = 'in_progress' AND expires_at > now()` |
| Release | Lua compare-and-delete | `DELETE` with the same conditions |

The semantics are the same: a second request sees `in_progress` (answered with `409`) or `completed` (replayed), the interceptor compares fingerprints and answers `422` on a mismatch, and a request whose lock expired can neither complete nor release the key once another request has taken it over.

## Cleaning up expired rows

Redis expires keys by itself; Postgres does not. Expired rows are harmless, because every query ignores them and the next request for the same key replaces its row, but they take space until something deletes them. Pick one:

- Call `store.deleteExpired()` on a timer in one of your instances. It runs `DELETE FROM idempotency_keys WHERE expires_at <= now()`, uses the `expires_at` index, and returns the number of rows removed. With `@nestjs/schedule`:

  ```ts
  @Cron(CronExpression.EVERY_HOUR)
  async pruneIdempotencyKeys(): Promise<void> {
    await this.store.deleteExpired();
  }
  ```

- Schedule the same statement in the database with `pg_cron`:

  ```sql
  SELECT cron.schedule('prune-idempotency-keys', '0 * * * *',
    $$DELETE FROM idempotency_keys WHERE expires_at <= now()$$);
  ```

Running the cleanup on several instances at once is safe; the deletes simply overlap. On a very busy table, run it more often rather than less, so each delete stays small.

## Testing against a real server

The unit tests run the store against an in-process fake. To run the same contract suite against Postgres, point `POSTGRES_URL` at a database you can create tables in:

```bash
createdb idempotency_test
POSTGRES_URL=postgres://localhost/idempotency_test pnpm test
```

Each run creates its own table and drops it afterwards.
