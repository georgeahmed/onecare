import { describe, it, expect } from 'vitest';
import { RedisIdempotencyStore, RedisLike } from '../src/idempotency-redis';

class FakeRedis implements RedisLike {
  private map = new Map<string, number>();
  async set(key: string, _value: string, mode?: string, ttlMode?: string, ttl?: number) {
    const now = Date.now();
    // GC
    for (const [k, exp] of this.map) if (exp <= now) this.map.delete(k);
    const expAt = now + (ttl ?? 0) * 1000;
    if (mode === 'NX') {
      if (this.map.has(key)) return null;
      this.map.set(key, expAt);
      return 'OK';
    }
    // fallback normal set with expiration
    this.map.set(key, expAt);
    return 'OK';
  }
  async exists(key: string) {
    const now = Date.now();
    for (const [k, exp] of this.map) if (exp <= now) this.map.delete(k);
    return this.map.has(key) ? 1 : 0;
  }
}

describe('RedisIdempotencyStore', () => {
  it('reserves atomically', async () => {
    const client = new FakeRedis();
    const store = new RedisIdempotencyStore(client);
    const key = 'abc';
    const ok1 = await store.reserve(key, 60);
    const ok2 = await store.reserve(key, 60);
    expect(ok1).toBe(true);
    expect(ok2).toBe(false);
    expect(await store.exists(key)).toBe(true);
  });
});

