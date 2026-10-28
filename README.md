# nestjs-idempotency

Safe retries for NestJS: `Idempotency-Key` handling for payment-style POST endpoints, with in-memory and Redis stores.

[![CI](https://github.com/ahmad-punch/nestjs-idempotency/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmad-punch/nestjs-idempotency/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)
[![NestJS](https://img.shields.io/badge/NestJS-11-e0234e.svg)](https://nestjs.com)

## Demo

```console
$ pnpm example     # starts example/main.ts on http://localhost:3000

$ curl -i -X POST localhost:3000/payments -H 'Idempotency-Key: 5f0c2a8e-order-42' \
    -H 'Content-Type: application/json' -d '{"amount":1000,"currency":"usd"}'
HTTP/1.1 201 Created
{"id":"pay_56c36b63","amount":1000,"currency":"usd"}

$ # the client times out and retries with the same key: same payment, no second charge
$ curl -i -X POST localhost:3000/payments -H 'Idempotency-Key: 5f0c2a8e-order-42' \
    -H 'Content-Type: application/json' -d '{"amount":1000,"currency":"usd"}'
HTTP/1.1 201 Created
Idempotent-Replayed: true
{"id":"pay_56c36b63","amount":1000,"currency":"usd"}

$ # same key, different payload: refused
$ curl -i -X POST localhost:3000/payments -H 'Idempotency-Key: 5f0c2a8e-order-42' \
    -H 'Content-Type: application/json' -d '{"amount":5000,"currency":"usd"}'
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json; charset=utf-8
{"type":"https://github.com/ahmad-punch/nestjs-idempotency#errors-key-reuse","title":"Idempotency key was already used for a different request","status":422,"detail":"This Idempotency-Key was first sent with a different payload. Retry with the original payload, or use a new key for a new request."}
```

## Why

Networks drop responses. A client that retries a `POST /payments` after a timeout cannot tell whether the first attempt charged the card. The [Idempotency-Key](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) pattern, popularised by Stripe, fixes this: the client sends a unique key, and the server guarantees that every request carrying that key gets the result of a single execution. This package gives NestJS that guarantee with one decorator, including the parts that are easy to get wrong: concurrent duplicates, payload mismatches, per-user scoping, and lock expiry across replicas.

## Install

```bash
pnpm add nestjs-idempotency
# for the Redis store
pnpm add ioredis
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` 11, `rxjs` 7, `reflect-metadata`. Works on Express and Fastify.

## Usage

The 30-second version:

```ts
import { Module, Controller, Post, Body } from '@nestjs/common';
import { IdempotencyModule, InMemoryIdempotencyStore, Idempotent } from 'nestjs-idempotency';

@Controller('payments')
class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @Idempotent()
  charge(@Body() body: { amount: number; currency: string }) {
    return this.payments.charge(body);
  }
}

@Module({
  imports: [IdempotencyModule.forRoot({ store: new InMemoryIdempotencyStore(), ttlSeconds: 86_400 })],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class AppModule {}
```

In production, share state between replicas with Redis:

```ts
import Redis from 'ioredis';
import { IdempotencyModule, RedisIdempotencyStore } from 'nestjs-idempotency';

IdempotencyModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    store: new RedisIdempotencyStore(new Redis(config.getOrThrow('REDIS_URL'))),
    ttlSeconds: 86_400,
    requireKey: true,
  }),
});
```

Cover every `POST` and `PATCH` route instead of decorating them one by one:

```ts
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from 'nestjs-idempotency';

providers: [{ provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor }];
```

Per-route overrides: `@Idempotent({ requireKey: true, ttlSeconds: 3600 })`. The decorator also works on a controller class.

### Configuration

| Option | Default | Description |
| --- | --- | --- |
| `store` | required | An `IdempotencyStore`: `InMemoryIdempotencyStore`, `RedisIdempotencyStore`, or your own. |
| `ttlSeconds` | `86400` | How long a completed response is replayed. |
| `keyHeader` | `'Idempotency-Key'` | Request header carrying the key. Bare (`abc`) and quoted (`"abc"`) values are accepted. |
| `requireKey` | `false` | Answer `400` when the header is missing. |
| `fingerprint` | SHA-256 of canonical JSON body | `(req) => string` deciding whether two requests are "the same". |
| `fingerprintHeaders` | `[]` | Request headers mixed into the default fingerprint. |
| `scope` | method + path + `req.user?.id` | `(req) => string` namespace for keys, so users never share records. |
| `responseHeaders` | `location`, `content-location`, `etag` | Response headers stored and replayed. |
| `lockTtlSeconds` | `60` | How long an in-flight request holds its key; set above your slowest handler. |
| `retryAfterSeconds` | `1` | `Retry-After` value on `409` responses. |
| `methods` | `['POST', 'PATCH']` | Methods covered when the interceptor is bound globally. |

`RedisIdempotencyStore(client, { keyPrefix })` defaults to the prefix `idempotency:`. `InMemoryIdempotencyStore({ sweepIntervalMs })` sweeps expired records every 60 s.

### Responses

| Situation | Result |
| --- | --- |
| First request with a key | Handler runs; status, body and whitelisted headers are stored. |
| Same key, same payload | Stored response replayed with `Idempotent-Replayed: true`. Handler does not run. |
| Same key, different payload | `422` problem details. |
| Same key while the first is still running | `409` problem details with `Retry-After`. |
| Key missing and `requireKey` | `400` problem details. |
| Handler throws | Nothing is stored; the key is freed so the client can retry it. |

### Errors: missing-key

The route requires an `Idempotency-Key`. Generate a UUID per logical operation and reuse it on every retry.

### Errors: invalid-key

The key is empty, sent twice, longer than 255 characters, or not printable ASCII.

### Errors: key-reuse

The key was first used with a different body. Retry with the original body, or use a new key.

### Errors: in-progress

Another request with the key is still running. Wait for `Retry-After` seconds and retry to receive its result.

## How it works

1. The interceptor reads the key, computes the scope (method, path, user) and the fingerprint (SHA-256 of the body with object keys sorted), and hashes scope + key into a store key.
2. `store.acquire()` atomically creates an in-progress record. In Redis this is `SET key lock PX lockTtl NX`. If a record already exists it is returned instead: a completed record with a matching fingerprint is replayed, a mismatch is a `422`, and an in-progress record is a `409`.
3. When the handler succeeds, `store.complete()` swaps the lock for the stored response, but only if the caller still owns the lock (a Lua compare-and-set in Redis). When it throws, `store.release()` deletes the lock the same way.

Store failures after the handler has run are logged, never turned into errors: the client already got a real response. See [docs/DESIGN.md](docs/DESIGN.md) for the main trade-off.

To back idempotency with another database, implement the three-method `IdempotencyStore` interface and run the contract suite in [`test/store-contract.ts`](test/store-contract.ts) against it.

## Development

```bash
pnpm install
pnpm test        # Jest: interceptor e2e on Express and Fastify, store contract on both stores
pnpm lint        # ESLint (type-checked) + tsc
pnpm build       # dist/ with .d.ts
pnpm example     # the demo above
```

## Roadmap

- Response-size limit with a clear log line when a body is too large to store.
- A Postgres store using `INSERT ... ON CONFLICT DO NOTHING`.
- Optional replay of streamed responses by buffering up to a configured size.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `pnpm lint && pnpm test` before opening a PR.

## License

[MIT](LICENSE) © 2026 Ahmad Salman Khan
