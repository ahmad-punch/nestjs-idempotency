import { sha256 } from './fingerprint';
import { type IdempotentRequest } from './idempotency.types';

/**
 * The default scope: method, path and the authenticated user's `id`.
 * Two users sending the same key never see each other's responses.
 * Unauthenticated requests share the `anonymous` scope.
 */
export function defaultScope(request: IdempotentRequest): string {
  return `${request.method} ${request.path} ${principalId(request.user)}`;
}

function principalId(user: unknown): string {
  if (typeof user === 'object' && user !== null && 'id' in user) {
    const id = user.id;
    if (typeof id === 'string' || typeof id === 'number' || typeof id === 'bigint') {
      return `user:${id}`;
    }
  }
  return 'anonymous';
}

/**
 * The key handed to the store: a digest of scope and client key, so stores
 * see fixed-length keys and client input never reaches a store key directly.
 */
export function storageKeyFor(scope: string, idempotencyKey: string): string {
  return sha256(`${scope}\n${idempotencyKey}`);
}
