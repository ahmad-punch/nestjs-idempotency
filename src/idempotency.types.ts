import { type IncomingHttpHeaders } from 'node:http';

/**
 * A platform-neutral view of the incoming request, built from the Express
 * or Fastify request so scope and fingerprint functions work on both.
 */
export interface IdempotentRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Request path without the query string. */
  path: string;
  /** Request headers with lower-case names. */
  headers: IncomingHttpHeaders;
  /** Parsed request body, if any. */
  body: unknown;
  /** The authenticated principal, usually set by a Passport guard. */
  user: unknown;
  /** The underlying Express or Fastify request. */
  raw: unknown;
}

/** Returns the namespace an idempotency key lives in. */
export type ScopeFn = (request: IdempotentRequest) => string | Promise<string>;

/** Returns a stable digest of everything that makes two requests "the same". */
export type FingerprintFn = (request: IdempotentRequest) => string | Promise<string>;
