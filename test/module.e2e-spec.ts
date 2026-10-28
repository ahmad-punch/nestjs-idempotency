import { Body, Controller, type INestApplication, Module, Post, Put, Res } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { IdempotencyInterceptor, IdempotencyModule, InMemoryIdempotencyStore } from '../src';
import { PaymentsController, PaymentsService } from './fixtures';

const payment = { amount: 1000, currency: 'usd' };

/** Undecorated routes, covered only by the global interceptor. */
@Controller('orders')
class OrdersController {
  private count = 0;

  @Post()
  create(@Body() body: object, @Res({ passthrough: true }) res: { status(code: number): void }): object {
    this.count++;
    res.status(200);
    return { order: this.count, ...body };
  }

  @Put()
  replace(): object {
    this.count++;
    return { order: this.count };
  }
}

@Module({
  providers: [{ provide: 'IDEMPOTENCY_TTL', useValue: 30 }],
  exports: ['IDEMPOTENCY_TTL'],
})
class ConfigModule {}

describe('IdempotencyModule.forRootAsync with a global interceptor', () => {
  let app: INestApplication<App>;
  let store: InMemoryIdempotencyStore;

  beforeEach(async () => {
    store = new InMemoryIdempotencyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IdempotencyModule.forRootAsync({
          imports: [ConfigModule],
          inject: ['IDEMPOTENCY_TTL'],
          useFactory: (ttlSeconds: number) => ({ store, ttlSeconds }),
        }),
      ],
      controllers: [OrdersController],
      providers: [{ provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  it('covers POST routes without @Idempotent() and replays a status set at runtime', async () => {
    const first = await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'k').send(payment).expect(200);
    const replay = await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'k').send(payment).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('ignores methods outside the configured list', async () => {
    await request(app.getHttpServer()).put('/orders').set('Idempotency-Key', 'k').expect(200);
    const second = await request(app.getHttpServer()).put('/orders').set('Idempotency-Key', 'k').expect(200);
    expect(second.body).toEqual({ order: 2 });
  });
});

describe('IdempotencyModule.forRoot without a store', () => {
  it('fails at startup with a message that says what to pass', async () => {
    const build = Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({} as never)],
    }).compile();
    await expect(build).rejects.toThrow(/needs a store/);
  });
});

describe('Idempotency on Fastify', () => {
  let app: NestFastifyApplication;
  let store: InMemoryIdempotencyStore;

  beforeEach(async () => {
    store = new InMemoryIdempotencyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ store })],
      controllers: [PaymentsController],
      providers: [PaymentsService],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const post = (key: string, body: object = payment) =>
    app.inject({ method: 'POST', url: '/payments/accepted', headers: { 'idempotency-key': key }, payload: body });

  it('replays the first response', async () => {
    const first = await post('k');
    const replay = await post('k');
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(app.get(PaymentsService).executions).toBe(1);
  });

  it('rejects a reused key with a different payload', async () => {
    await post('k');
    const mismatch = await post('k', { amount: 1, currency: 'usd' });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
