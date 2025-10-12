import type { IdempotencyStore } from './idempotency';

export interface RedisLike {
  set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> | 'OK' | null;
  exists(key: string): Promise<number> | number;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly client: RedisLike, private readonly prefix = 'idem:') {}

  private k(key: string) { return `${this.prefix}${key}`; }

  async exists(key: string): Promise<boolean> {
    const n = await this.client.exists(this.k(key));
    return Number(n) > 0;
  }

  async put(key: string, ttlSeconds: number): Promise<void> {
    // Non-atomic put (used only as fallback by helper)
    await this.client.set(this.k(key), '1', 'EX', ttlSeconds);
  }

  async reserve(key: string, ttlSeconds: number): Promise<'reserved' | 'exists'> {
    // Atomic reserve using SET NX EX ttl
    const res = await this.client.set(this.k(key), '1', 'NX', 'EX', ttlSeconds);
    return res === 'OK' ? 'reserved' : 'exists';
  }
}
