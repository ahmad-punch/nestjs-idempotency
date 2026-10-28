import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisIdempotencyStore } from '../src';
import { describeStoreContract } from './store-contract';

const redis: Redis = new RedisMock();

beforeEach(async () => {
  await redis.flushall();
});

describeStoreContract('RedisIdempotencyStore', () => new RedisIdempotencyStore(redis));

describe('RedisIdempotencyStore', () => {
  it('accepts a real ioredis client type', () => {
    const typed: ConstructorParameters<typeof RedisIdempotencyStore>[0] = redis;
    expect(typed).toBeDefined();
  });

  it('writes under the configured key prefix', async () => {
    const store = new RedisIdempotencyStore(redis, { keyPrefix: 'shop:idem:' });
    await store.acquire('abc', 'fp', 1000);
    await expect(redis.keys('shop:idem:*')).resolves.toEqual(['shop:idem:abc']);
  });

  it('sets a TTL on the lock and on the completed record', async () => {
    const store = new RedisIdempotencyStore(redis);
    const result = await store.acquire('abc', 'fp', 5000);
    if (!result.acquired) throw new Error('expected to acquire');
    const lockTtl = await redis.pttl('idempotency:abc');
    expect(lockTtl).toBeGreaterThan(0);
    expect(lockTtl).toBeLessThanOrEqual(5000);
    await store.complete(result.lease, { statusCode: 201, headers: {} }, 60_000);
    expect(await redis.pttl('idempotency:abc')).toBeGreaterThan(5000);
  });

  it('explains what to do when a key holds foreign data', async () => {
    await redis.set('idempotency:abc', 'not json');
    const store = new RedisIdempotencyStore(redis);
    await expect(store.acquire('abc', 'fp', 1000)).rejects.toThrow(/set a distinct keyPrefix/);
  });
});
