import { type IncomingHttpHeaders } from 'node:http';

export const MAX_KEY_LENGTH = 255;

export type KeyParseResult =
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid'; key: string };

/**
 * Read the idempotency key header. Accepts both the IETF draft form, a
 * quoted structured-field string (`"abc"`), and the bare form Stripe uses.
 */
export function readIdempotencyKey(headers: IncomingHttpHeaders, headerName: string): KeyParseResult {
  const raw = headers[headerName.toLowerCase()];
  if (raw === undefined) {
    return { status: 'missing' };
  }
  if (Array.isArray(raw)) {
    return { status: 'invalid', reason: `Send exactly one ${headerName} header.` };
  }
  const key = unquote(raw.trim());
  if (key.length === 0) {
    return { status: 'invalid', reason: `${headerName} must not be empty.` };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return {
      status: 'invalid',
      reason: `${headerName} must be at most ${MAX_KEY_LENGTH} characters; a UUID is a good choice.`,
    };
  }
  if (!/^[\x20-\x7e]+$/.test(key)) {
    return { status: 'invalid', reason: `${headerName} must contain printable ASCII characters only.` };
  }
  return { status: 'valid', key };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
