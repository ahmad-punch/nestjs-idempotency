import { ConfigurableModuleBuilder, Global, Module } from '@nestjs/common';
import { IDEMPOTENCY_OPTIONS } from './idempotency.constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { type IdempotencyModuleOptions, resolveOptions } from './idempotency.options';

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<IdempotencyModuleOptions>({
  moduleName: 'Idempotency',
})
  .setClassMethodName('forRoot')
  .build();

/**
 * Registers the idempotency store and options for the whole application.
 * The module is global, so `@Idempotent()` works in every feature module.
 *
 * ```ts
 * IdempotencyModule.forRoot({ store: new InMemoryIdempotencyStore() })
 * IdempotencyModule.forRootAsync({ inject: [Redis], useFactory: (redis: Redis) => ({ store: new RedisIdempotencyStore(redis) }) })
 * ```
 */
@Global()
@Module({
  providers: [
    { provide: IDEMPOTENCY_OPTIONS, inject: [MODULE_OPTIONS_TOKEN], useFactory: resolveOptions },
    IdempotencyInterceptor,
  ],
  exports: [IDEMPOTENCY_OPTIONS, IdempotencyInterceptor],
})
export class IdempotencyModule extends ConfigurableModuleClass {}
