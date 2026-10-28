import { type IdempotencyStore, type StoredResponse } from '../src';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const response: StoredResponse = {
  statusCode: 201,
  headers: { location: '/payments/pay_1' },
  body: { id: 'pay_1', amount: 1000, nested: { currency: 'usd' } },
};

/**
 * Behaviour every IdempotencyStore must provide. Run it against your own
 * store implementation to check it before wiring it into the module.
 */
export function describeStoreContract(name: string, createStore: () => IdempotencyStore | Promise<IdempotencyStore>): void {
  describe(`${name} (IdempotencyStore contract)`, () => {
    let store: IdempotencyStore;

    beforeEach(async () => {
      store = await createStore();
    });

    it('acquires a fresh key and returns a lease', async () => {
      const result = await store.acquire('k1', 'fp', 1000);
      expect(result.acquired).toBe(true);
      if (result.acquired) {
        expect(result.lease).toMatchObject({ key: 'k1', fingerprint: 'fp' });
        expect(typeof result.lease.token).toBe('string');
      }
    });

    it('reports an in-progress record to a second caller', async () => {
      await store.acquire('k1', 'fp', 1000);
      await expect(store.acquire('k1', 'other', 1000)).resolves.toEqual({
        acquired: false,
        record: { status: 'in_progress', fingerprint: 'fp' },
      });
    });

    it('lets exactly one of many concurrent callers acquire a key', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => store.acquire('k1', 'fp', 1000)));
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
    });

    it('returns the completed response after complete()', async () => {
      const first = await store.acquire('k1', 'fp', 1000);
      if (!first.acquired) throw new Error('expected to acquire');
      await expect(store.complete(first.lease, response, 1000)).resolves.toBe(true);
      await expect(store.acquire('k1', 'fp', 1000)).resolves.toEqual({
        acquired: false,
        record: { status: 'completed', fingerprint: 'fp', response },
      });
    });

    it('frees the key after release()', async () => {
      const first = await store.acquire('k1', 'fp', 1000);
      if (!first.acquired) throw new Error('expected to acquire');
      await expect(store.release(first.lease)).resolves.toBe(true);
      const second = await store.acquire('k1', 'fp', 1000);
      expect(second.acquired).toBe(true);
    });

    it('refuses complete() and release() from a lease that no longer owns the key', async () => {
      const first = await store.acquire('k1', 'fp', 1000);
      if (!first.acquired) throw new Error('expected to acquire');
      const stale = { ...first.lease, token: 'not-the-owner' };
      await expect(store.complete(stale, response, 1000)).resolves.toBe(false);
      await expect(store.release(stale)).resolves.toBe(false);
      await expect(store.acquire('k1', 'fp', 1000)).resolves.toMatchObject({
        acquired: false,
        record: { status: 'in_progress' },
      });
    });

    it('refuses to complete twice with the same lease', async () => {
      const first = await store.acquire('k1', 'fp', 1000);
      if (!first.acquired) throw new Error('expected to acquire');
      await store.complete(first.lease, response, 1000);
      await expect(store.complete(first.lease, { ...response, statusCode: 500 }, 1000)).resolves.toBe(false);
      await expect(store.release(first.lease)).resolves.toBe(false);
    });

    it('expires an abandoned lock after lockTtlMs', async () => {
      const first = await store.acquire('k1', 'fp', 40);
      if (!first.acquired) throw new Error('expected to acquire');
      await sleep(80);
      const second = await store.acquire('k1', 'fp', 1000);
      expect(second.acquired).toBe(true);
      await expect(store.complete(first.lease, response, 1000)).resolves.toBe(false);
    });

    it('expires a completed record after ttlMs', async () => {
      const first = await store.acquire('k1', 'fp', 1000);
      if (!first.acquired) throw new Error('expected to acquire');
      await store.complete(first.lease, response, 40);
      await sleep(80);
      await expect(store.acquire('k1', 'fp', 1000)).resolves.toMatchObject({ acquired: true });
    });

    it('keeps keys independent', async () => {
      await store.acquire('k1', 'fp', 1000);
      await expect(store.acquire('k2', 'fp', 1000)).resolves.toMatchObject({ acquired: true });
    });
  });
}
