import { InMemoryIdempotencyStore } from '../src';
import { describeStoreContract } from './store-contract';

const stores: InMemoryIdempotencyStore[] = [];
afterAll(() => stores.forEach((store) => store.close()));

describeStoreContract('InMemoryIdempotencyStore', () => {
  const store = new InMemoryIdempotencyStore();
  stores.push(store);
  return store;
});

describe('InMemoryIdempotencyStore', () => {
  it('sweeps expired records', async () => {
    let now = 0;
    const store = new InMemoryIdempotencyStore({ now: () => now, sweepIntervalMs: 0 });
    await store.acquire('a', 'fp', 100);
    await store.acquire('b', 'fp', 500);
    now = 200;
    expect(store.size).toBe(1);
    now = 600;
    expect(store.size).toBe(0);
  });

  it('does not let callers mutate a stored response', async () => {
    const store = new InMemoryIdempotencyStore({ sweepIntervalMs: 0 });
    const result = await store.acquire('a', 'fp', 1000);
    if (!result.acquired) throw new Error('expected to acquire');
    const body = { amount: 1 };
    await store.complete(result.lease, { statusCode: 201, headers: {}, body }, 1000);
    body.amount = 2;
    const replay = await store.acquire('a', 'fp', 1000);
    expect(replay).toMatchObject({ record: { response: { body: { amount: 1 } } } });
  });
});
