# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-11

### Added
- `PostgresIdempotencyStore`, which claims keys with `INSERT ... ON CONFLICT DO NOTHING` and completes or releases them only while the caller's lock is current, matching the Redis store. It accepts any client with a `pg`-style `query` method; `pg` is an optional peer dependency.
- `postgresIdempotencyTableSql()` and `store.createTable()` for the table DDL, and `store.deleteExpired()` for pruning expired rows. See `docs/POSTGRES.md`.
- `maxResponseBytes` option. A response whose JSON body is larger is sent but not stored, the key is released, and one warning names the key, route, size and limit.

### Fixed
- `pnpm lint` no longer fails after `pnpm example` has written `dist-example/`.

## [0.1.0] - 2026-10-28

### Added
- `IdempotencyModule.forRoot` and `forRootAsync`, global across the application.
- `@Idempotent()` decorator with per-route `ttlSeconds` and `requireKey`, and `IdempotencyInterceptor` for global use.
- Replay of status, body and whitelisted headers with `Idempotent-Replayed: true`.
- RFC 9457 problem details for missing or invalid keys (400), key reuse with a different payload (422) and concurrent in-flight requests (409 with `Retry-After`).
- Default scope of method, path and `req.user.id`; default fingerprint of SHA-256 over canonical JSON of the body.
- `InMemoryIdempotencyStore` with a TTL sweep, and `RedisIdempotencyStore` using `SET NX PX` locks and Lua compare-and-set.
- Reusable store contract test suite.
