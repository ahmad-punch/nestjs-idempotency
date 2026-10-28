import { createHash } from 'node:crypto';
import { type IncomingHttpHeaders } from 'node:http';
import { type FingerprintFn, type IdempotentRequest } from './idempotency.types';

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Serialise a value to JSON with object keys sorted at every level, so two
 * payloads that differ only in key order produce the same string.
 * Follows `JSON.stringify` for everything else: `toJSON` is honoured,
 * `undefined` properties are dropped, and non-finite numbers become `null`.
 * BigInts are written as strings.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value) ?? 'null';
}

function serialize(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object':
      return serializeObject(value);
    default:
      return undefined;
  }
}

function serializeObject(value: object): string | undefined {
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return serialize(withToJson.toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item) ?? 'null').join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = serialize(record[key]);
    if (member !== undefined) {
      members.push(`${JSON.stringify(key)}:${member}`);
    }
  }
  return `{${members.join(',')}}`;
}

/**
 * The default fingerprint: SHA-256 of the canonical JSON of the request body
 * plus the named request headers.
 */
export function createDefaultFingerprint(headerNames: readonly string[] = []): FingerprintFn {
  const names = headerNames.map((name) => name.toLowerCase());
  return (request: IdempotentRequest) =>
    sha256(
      canonicalJson({
        body: request.body ?? null,
        headers: pickHeaders(request.headers, names),
      }),
    );
}

function pickHeaders(headers: IncomingHttpHeaders, names: readonly string[]): Record<string, string | null> {
  const picked: Record<string, string | null> = {};
  for (const name of names) {
    const value = headers[name];
    picked[name] = Array.isArray(value) ? value.join(', ') : (value ?? null);
  }
  return picked;
}
