import { type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type App } from 'supertest/types';
import { IdempotencyModule, InMemoryIdempotencyStore } from '../src';
import { FakeAuthGuard, Gate, PaymentsController, PaymentsService } from './fixtures';

const payment = { amount: 1000, currency: 'usd' };

describe('Idempotency on Express', () => {
  let app: INestApplication<App>;
  let store: InMemoryIdempotencyStore;
  let payments: PaymentsService;

  beforeEach(async () => {
    store = new InMemoryIdempotencyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule.forRoot({ store, ttlSeconds: 60, retryAfterSeconds: 2 })],
      controllers: [PaymentsController],
      providers: [PaymentsService, { provide: APP_GUARD, useClass: FakeAuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    payments = app.get(PaymentsService);
  });

  afterEach(async () => {
    await app.close();
    store.close();
  });

  const post = (path: string, key?: string, body: object = payment) => {
    const req = request(app.getHttpServer()).post(path).send(body);
    return key === undefined ? req : req.set('Idempotency-Key', key);
  };

  it('replays the stored status, body and whitelisted headers', async () => {
    const first = await post('/payments', 'key-1').expect(201);
    const replay = await post('/payments', 'key-1').expect(201);

    expect(replay.body).toEqual(first.body);
    expect(replay.body).toEqual({ id: 'pay_1', amount: 1000, currency: 'usd' });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.headers.location).toBe('/payments/pay_1');
    expect(replay.headers['x-request-cost']).toBeUndefined();
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(payments.executions).toBe(1);
  });

  it('treats a reordered JSON body as the same request', async () => {
    await post('/payments', 'key-1', { amount: 1000, currency: 'usd' }).expect(201);
    await post('/payments', 'key-1', { currency: 'usd', amount: 1000 }).expect(201);
    expect(payments.executions).toBe(1);
  });

  it('accepts the quoted structured-field form of the key', async () => {
    await post('/payments', 'key-1').expect(201);
    const replay = await post('/payments', '"key-1"').expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('keeps a custom @HttpCode on replay', async () => {
    await post('/payments/accepted', 'key-1').expect(202);
    const replay = await post('/payments/accepted', 'key-1').expect(202);
    expect(replay.body).toEqual({ id: 'pay_1', amount: 1000, currency: 'usd' });
  });

  it('replays handlers that return nothing', async () => {
    await post('/payments/empty', 'key-1').expect(204);
    const replay = await post('/payments/empty', 'key-1').expect(204);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(payments.executions).toBe(1);
  });

  it('rejects the same key with a different payload with 422 problem details', async () => {
    await post('/payments', 'key-1').expect(201);
    const mismatch = await post('/payments', 'key-1', { amount: 9999, currency: 'usd' }).expect(422);

    expect(mismatch.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(mismatch.body).toMatchObject({
      type: expect.stringContaining('#errors-key-reuse'),
      title: 'Idempotency key was already used for a different request',
      status: 422,
    });
    expect(payments.executions).toBe(1);
  });

  it('answers 409 with Retry-After while the first request is in flight', async () => {
    const gate = new Gate();
    payments.gate = gate;
    const first = post('/payments', 'key-1').then((res) => res);
    await gate.reached;

    const concurrent = await post('/payments', 'key-1').expect(409);
    expect(concurrent.headers['retry-after']).toBe('2');
    expect(concurrent.body).toMatchObject({ status: 409, type: expect.stringContaining('#errors-in-progress') });

    gate.release();
    expect((await first).status).toBe(201);
    expect(payments.executions).toBe(1);
  });

  it('prefers 422 over 409 when an in-flight key is reused with another payload', async () => {
    const gate = new Gate();
    payments.gate = gate;
    const first = post('/payments', 'key-1').then((res) => res);
    await gate.reached;

    await post('/payments', 'key-1', { amount: 1, currency: 'usd' }).expect(422);

    gate.release();
    await first;
  });

  it('runs the handler again once the record has expired', async () => {
    await post('/payments/short-lived', 'key-1').expect(201);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const again = await post('/payments/short-lived', 'key-1').expect(201);

    expect(again.headers['idempotent-replayed']).toBeUndefined();
    expect(again.body.id).toBe('pay_2');
  });

  it('scopes keys to the authenticated user', async () => {
    const alice = await post('/payments', 'shared-key').set('x-user-id', 'alice').expect(201);
    const bob = await post('/payments', 'shared-key').set('x-user-id', 'bob').expect(201);
    const aliceAgain = await post('/payments', 'shared-key').set('x-user-id', 'alice').expect(201);

    expect(bob.body.id).not.toBe(alice.body.id);
    expect(bob.headers['idempotent-replayed']).toBeUndefined();
    expect(aliceAgain.body).toEqual(alice.body);
    expect(payments.executions).toBe(2);
  });

  it('scopes keys to the route', async () => {
    await post('/payments', 'key-1').expect(201);
    const other = await post('/payments/accepted', 'key-1').expect(202);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
    expect(payments.executions).toBe(2);
  });

  it('passes requests without a key straight through', async () => {
    await post('/payments').expect(201);
    await post('/payments').expect(201);
    expect(payments.executions).toBe(2);
  });

  it('answers 400 when a required key is missing', async () => {
    const res = await post('/payments/strict').expect(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, detail: expect.stringContaining('Idempotency-Key') });
    expect(payments.executions).toBe(0);
  });

  it('answers 400 for an over-long key', async () => {
    await post('/payments', 'x'.repeat(256)).expect(400);
    expect(payments.executions).toBe(0);
  });

  it('does not store errors, so the client can retry with the same key', async () => {
    payments.failNext = true;
    await post('/payments', 'key-1').expect(503);
    const retry = await post('/payments', 'key-1').expect(201);

    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(payments.executions).toBe(2);
  });

  it('leaves undecorated routes alone', async () => {
    await post('/payments/plain', 'key-1').expect(201);
    await post('/payments/plain', 'key-1').expect(201);
    expect(payments.executions).toBe(2);
  });
});
