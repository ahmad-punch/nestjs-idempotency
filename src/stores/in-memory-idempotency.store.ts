import { randomUUID } from 'node:crypto';
import {
  type AcquireResult,
  type IdempotencyLease,
  type IdempotencyRecord,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency-store.interface';

export interface InMemoryIdempotencyStoreOptions {
  /** How often expired entries are swept. Defaults to 60 000 ms; 0 disables the sweep. */
  sweepIntervalMs?: number;
  /** Clock used for expiry. Override it in tests. Defaults to `Date.now`. */
  now?: () => number;
}

type Entry =
  | { status: 'in_progress'; fingerprint: string; token: string; expiresAt: number }
  | {
      status: 'completed';
      fingerprint: string;
      response: StoredResponse;
      expiresAt: number;
    };

/**
 * A single-process store for tests and local development.
 * Records live in a `Map` and vanish on restart, and the lock only protects
 * requests that hit this process, so use a shared store in production.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly sweepTimer?: NodeJS.Timeout;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    const interval = options.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), interval);
      this.sweepTimer.unref();
    }
  }

  /** Number of live records. */
  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  acquire(key: string, fingerprint: string, lockTtlMs: number): Promise<AcquireResult> {
    const existing = this.liveEntry(key);
    if (existing) {
      return Promise.resolve({ acquired: false, record: toRecord(existing) });
    }
    const token = randomUUID();
    this.entries.set(key, {
      status: 'in_progress',
      fingerprint,
      token,
      expiresAt: this.now() + lockTtlMs,
    });
    return Promise.resolve({ acquired: true, lease: { key, token, fingerprint } });
  }

  complete(lease: IdempotencyLease, response: StoredResponse, ttlMs: number): Promise<boolean> {
    if (!this.ownsLock(lease)) {
      return Promise.resolve(false);
    }
    this.entries.set(lease.key, {
      status: 'completed',
      fingerprint: lease.fingerprint,
      response: structuredClone(response),
      expiresAt: this.now() + ttlMs,
    });
    return Promise.resolve(true);
  }

  release(lease: IdempotencyLease): Promise<boolean> {
    if (!this.ownsLock(lease)) {
      return Promise.resolve(false);
    }
    this.entries.delete(lease.key);
    return Promise.resolve(true);
  }

  /** Remove every expired record. Runs on a timer; call it directly if you disabled the timer. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  /** Drop all records. */
  clear(): void {
    this.entries.clear();
  }

  /** Stop the sweep timer. */
  close(): void {
    clearInterval(this.sweepTimer);
  }

  private liveEntry(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private ownsLock(lease: IdempotencyLease): boolean {
    const entry = this.liveEntry(lease.key);
    return entry?.status === 'in_progress' && entry.token === lease.token;
  }
}

function toRecord(entry: Entry): IdempotencyRecord {
  if (entry.status === 'in_progress') {
    return { status: 'in_progress', fingerprint: entry.fingerprint };
  }
  return {
    status: 'completed',
    fingerprint: entry.fingerprint,
    response: structuredClone(entry.response),
  };
}
