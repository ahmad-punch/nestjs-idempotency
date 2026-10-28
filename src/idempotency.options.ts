import { DEFAULT_KEY_HEADER } from './idempotency.constants';
import { createDefaultFingerprint } from './fingerprint';
import { type FingerprintFn, type ScopeFn } from './idempotency.types';
import { defaultScope } from './scope';
import { type IdempotencyStore } from './stores/idempotency-store.interface';

export interface IdempotencyModuleOptions {
  /** Where records and locks live. Use `RedisIdempotencyStore` in production. */
  store: IdempotencyStore;
  /** How long a completed response is replayed for. Defaults to 86 400 (24 hours). */
  ttlSeconds?: number;
  /** Request header carrying the key. Defaults to `Idempotency-Key`. */
  keyHeader?: string;
  /** Reject requests without a key with 400. Defaults to `false`. */
  requireKey?: boolean;
  /** Replaces the default body-plus-headers SHA-256 fingerprint. */
  fingerprint?: FingerprintFn;
  /** Request headers included in the default fingerprint. Defaults to none. */
  fingerprintHeaders?: string[];
  /** Namespace for keys. Defaults to method + path + `req.user?.id`. */
  scope?: ScopeFn;
  /** Response headers stored and replayed. Defaults to `location`, `content-location` and `etag`. */
  responseHeaders?: string[];
  /** How long an in-flight request holds its key before another may take over. Defaults to 60. */
  lockTtlSeconds?: number;
  /** Value of `Retry-After` on 409 responses. Defaults to 1. */
  retryAfterSeconds?: number;
  /**
   * HTTP methods covered when the interceptor is bound to a route that has
   * no `@Idempotent()` decorator, for example when registered globally.
   * Defaults to `POST` and `PATCH`.
   */
  methods?: string[];
}

export interface ResolvedIdempotencyOptions {
  store: IdempotencyStore;
  ttlSeconds: number;
  keyHeader: string;
  requireKey: boolean;
  fingerprint: FingerprintFn;
  scope: ScopeFn;
  responseHeaders: string[];
  lockTtlSeconds: number;
  retryAfterSeconds: number;
  methods: string[];
}

export function resolveOptions(options: IdempotencyModuleOptions): ResolvedIdempotencyOptions {
  if (!options?.store) {
    throw new Error(
      'IdempotencyModule needs a store. Pass `store: new InMemoryIdempotencyStore()` for development ' +
        'or `store: new RedisIdempotencyStore(redis)` for production.',
    );
  }
  return {
    store: options.store,
    ttlSeconds: positive('ttlSeconds', options.ttlSeconds ?? 86_400),
    keyHeader: options.keyHeader ?? DEFAULT_KEY_HEADER,
    requireKey: options.requireKey ?? false,
    fingerprint: options.fingerprint ?? createDefaultFingerprint(options.fingerprintHeaders),
    scope: options.scope ?? defaultScope,
    responseHeaders: (options.responseHeaders ?? ['location', 'content-location', 'etag']).map((name) =>
      name.toLowerCase(),
    ),
    lockTtlSeconds: positive('lockTtlSeconds', options.lockTtlSeconds ?? 60),
    retryAfterSeconds: positive('retryAfterSeconds', options.retryAfterSeconds ?? 1),
    methods: (options.methods ?? ['POST', 'PATCH']).map((method) => method.toUpperCase()),
  };
}

export function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`IdempotencyModule option "${name}" must be a positive number of seconds; got ${value}.`);
  }
  return value;
}
