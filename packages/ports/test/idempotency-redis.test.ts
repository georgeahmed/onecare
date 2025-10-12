import { describe, it, expect } from 'vitest';
import { RedisIdempotencyStore, RedisLike } from '../src/idempotency-redis';

class FakeRedis implements RedisLike {
  private map = new Map<string, number>();

  async set(key: string, _value: string, ...args: Array<string | number>) {
    this.gc();
    let ttlSeconds: number | undefined;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (typeof arg === 'string') {
        const upper = arg.toUpperCase();
        if (upper === 'NX') {
          nx = true;
        } else if ((upper === 'EX' || upper === 'PX') && typeof args[i + 1] === 'number') {
          const ttl = Number(args[i + 1]);
          ttlSeconds = upper === 'PX' ? Math.ceil(ttl / 1000) : ttl;
          i += 1;
        }
      }
    }
    if (nx && this.map.has(key)) {
      return null;
    }
    const expiry = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.POSITIVE_INFINITY;
    this.map.set(key, expiry);
    return 'OK';
  }

  async exists(key: string) {
    this.gc();
    return this.map.has(key) ? 1 : 0;
  }

  async del(key: string) {
    this.map.delete(key);
    return 1;
  }

  getExpiry(key: string): number | undefined {
    this.gc();
    const value = this.map.get(key);
    return value === Number.POSITIVE_INFINITY ? undefined : value;
  }

  private gc() {
    const now = Date.now();
    for (const [k, exp] of this.map) {
      if (exp !== Number.POSITIVE_INFINITY && exp <= now) {
        this.map.delete(k);
      }
    }
  }
}

describe('RedisIdempotencyStore', () => {
  it('reserves atomically', async () => {
    const client = new FakeRedis();
    const store = new RedisIdempotencyStore(client);
    const key = 'abc';
    const ok1 = await store.reserve(key, 60);
    const ok2 = await store.reserve(key, 60);
    expect(ok1).toBe('reserved');
    expect(ok2).toBe('exists');
    expect(await store.exists(key)).toBe(true);
  });

  it('applies ttl when using put fallback', async () => {
    const client = new FakeRedis();
    const store = new RedisIdempotencyStore(client);
    await store.put('fallback', 30);
    const expiry = client.getExpiry('idem:fallback');
    expect(typeof expiry).toBe('number');
    expect(expiry! - Date.now()).toBeGreaterThan(25_000);
  });
});
