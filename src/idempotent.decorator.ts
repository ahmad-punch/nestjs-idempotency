import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { IDEMPOTENT_METADATA } from './idempotency.constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { positive } from './idempotency.options';

/** Per-route overrides for `@Idempotent()`. */
export interface IdempotentOptions {
  /** How long the response is replayed for. Defaults to the module's `ttlSeconds`. */
  ttlSeconds?: number;
  /** Reject requests without a key. Defaults to the module's `requireKey`. */
  requireKey?: boolean;
}

/**
 * Make a route safe to retry with an `Idempotency-Key` header.
 * Can be applied to a handler or to a whole controller.
 */
export function Idempotent(options: IdempotentOptions = {}): MethodDecorator & ClassDecorator {
  if (options.ttlSeconds !== undefined) {
    positive('ttlSeconds', options.ttlSeconds);
  }
  return applyDecorators(SetMetadata(IDEMPOTENT_METADATA, options), UseInterceptors(IdempotencyInterceptor));
}
