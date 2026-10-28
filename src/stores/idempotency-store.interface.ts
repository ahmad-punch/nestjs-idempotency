/**
 * The response captured from the first execution of an idempotent request.
 * It must survive a JSON round trip, because stores are free to serialise it.
 */
export interface StoredResponse {
  statusCode: number;
  /** Response headers from the configured whitelist, lower-cased. */
  headers: Record<string, string>;
  /** The value the handler returned. Absent when the handler returned nothing. */
  body?: unknown;
}

/**
 * Proof that the caller owns the in-progress record for `key`.
 * Returned by {@link IdempotencyStore.acquire} and handed back to
 * `complete` or `release`, which must only act if the lease is still current.
 */
export interface IdempotencyLease {
  key: string;
  token: string;
  fingerprint: string;
}

export type IdempotencyRecord =
  | { status: 'in_progress'; fingerprint: string }
  | { status: 'completed'; fingerprint: string; response: StoredResponse };

export type AcquireResult =
  | { acquired: true; lease: IdempotencyLease }
  | { acquired: false; record: IdempotencyRecord };

/**
 * Persistence and locking for idempotency keys.
 *
 * Every method must be atomic with respect to other processes sharing the
 * store; that is what makes the guarantee hold across replicas. Implement
 * this interface to back idempotency with Postgres, DynamoDB and so on.
 */
export interface IdempotencyStore {
  /**
   * Create an in-progress record for `key` if no live record exists.
   * When one exists, return it untouched so the caller can replay or reject.
   * The in-progress record must expire after `lockTtlMs` so a crashed
   * process cannot hold a key forever.
   */
  acquire(key: string, fingerprint: string, lockTtlMs: number): Promise<AcquireResult>;

  /**
   * Replace the in-progress record owned by `lease` with the completed
   * response, kept for `ttlMs`. Returns `false` (and writes nothing) when the
   * lease is no longer current, for example because the lock expired.
   */
  complete(lease: IdempotencyLease, response: StoredResponse, ttlMs: number): Promise<boolean>;

  /**
   * Delete the in-progress record owned by `lease` so the key can be retried.
   * Returns `false` when the lease is no longer current.
   */
  release(lease: IdempotencyLease): Promise<boolean>;
}
