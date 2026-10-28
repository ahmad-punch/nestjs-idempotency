/** Injection token for the resolved module options. */
export const IDEMPOTENCY_OPTIONS = Symbol('IDEMPOTENCY_OPTIONS');

/** Metadata key written by `@Idempotent()`. */
export const IDEMPOTENT_METADATA = 'nestjs-idempotency:idempotent';

/** Response header set on replayed responses, matching Stripe. */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

export const DEFAULT_KEY_HEADER = 'Idempotency-Key';
