import { randomUUID } from 'node:crypto';
import {
  type AcquireResult,
  type IdempotencyLease,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency-store.interface';

/**
 * The subset of the `ioredis` client this store uses. Any `ioredis` `Redis`
 * or `Cluster` instance satisfies it, so `ioredis` stays an optional peer.
 */
export interface RedisClientLike {
  set(key: string, value: string, px: 'PX', milliseconds: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisIdempotencyStoreOptions {
  /** Prefix for every key this store writes. Defaults to `idempotency:`. */
  keyPrefix?: string;
}

/**
 * Replace the value at KEYS[1] only if it still equals ARGV[1] (our lock).
 * ARGV[2] is the new value and ARGV[3] its TTL in milliseconds.
 */
const COMPARE_AND_SET = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`;

/** Delete KEYS[1] only if it still equals ARGV[1] (our lock). */
const COMPARE_AND_DELETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** A lock can expire between a failed SET NX and the GET that follows it. */
const MAX_ACQUIRE_ATTEMPTS = 3;

type EncodedRecord =
  | { s: 'p'; f: string; t: string }
  | { s: 'c'; f: string; r: StoredResponse };

/**
 * A store backed by Redis, safe to share between any number of processes.
 *
 * Locks are taken with `SET key value PX ttl NX`. Completing or releasing a
 * lock runs a Lua script that compares the stored value with the caller's
 * lock first, so a request whose lock expired can never overwrite the
 * record of the request that took over the key.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: RedisClientLike,
    options: RedisIdempotencyStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'idempotency:';
  }

  async acquire(key: string, fingerprint: string, lockTtlMs: number): Promise<AcquireResult> {
    const redisKey = this.keyPrefix + key;
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      const lease: IdempotencyLease = { key, token: randomUUID(), fingerprint };
      const created = await this.client.set(redisKey, encodeLock(lease), 'PX', toMs(lockTtlMs), 'NX');
      if (created === 'OK') {
        return { acquired: true, lease };
      }
      const existing = await this.client.get(redisKey);
      if (existing !== null) {
        return { acquired: false, record: decodeRecord(existing, redisKey) };
      }
    }
    throw new Error(
      `Could not acquire idempotency key "${redisKey}" after ${MAX_ACQUIRE_ATTEMPTS} attempts; ` +
        'locks are expiring faster than Redis can be read. Increase lockTtlSeconds.',
    );
  }

  async complete(lease: IdempotencyLease, response: StoredResponse, ttlMs: number): Promise<boolean> {
    const completed: EncodedRecord = { s: 'c', f: lease.fingerprint, r: response };
    const result = await this.client.eval(
      COMPARE_AND_SET,
      1,
      this.keyPrefix + lease.key,
      encodeLock(lease),
      JSON.stringify(completed),
      toMs(ttlMs),
    );
    return Number(result) === 1;
  }

  async release(lease: IdempotencyLease): Promise<boolean> {
    const result = await this.client.eval(
      COMPARE_AND_DELETE,
      1,
      this.keyPrefix + lease.key,
      encodeLock(lease),
    );
    return Number(result) === 1;
  }
}

/** The lock value is derived from the lease alone, so it can be rebuilt for comparison. */
function encodeLock(lease: IdempotencyLease): string {
  const lock: EncodedRecord = { s: 'p', f: lease.fingerprint, t: lease.token };
  return JSON.stringify(lock);
}

function decodeRecord(raw: string, redisKey: string): IdempotencyRecord {
  const parsed = parseJson(raw);
  if (isObject(parsed) && typeof parsed.f === 'string') {
    if (parsed.s === 'p') {
      return { status: 'in_progress', fingerprint: parsed.f };
    }
    if (parsed.s === 'c' && isObject(parsed.r)) {
      return { status: 'completed', fingerprint: parsed.f, response: parsed.r as unknown as StoredResponse };
    }
  }
  throw new Error(
    `Redis key "${redisKey}" does not hold an idempotency record. ` +
      'Another application may be writing under the same prefix; set a distinct keyPrefix.',
  );
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
