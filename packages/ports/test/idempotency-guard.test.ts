import { describe, expect, it, vi } from 'vitest';
import { executeWithIdempotency } from '../src/idempotency-guard';
import type { IdempotencyStore } from '../src/idempotency';

class MemoryStore implements IdempotencyStore {
  private readonly entries = new Map<string, number>();

  async exists(key: string): Promise<boolean> {
    this.prune();
    return this.entries.has(key);
  }

  async put(key: string, ttlSeconds: number): Promise<void> {
    const expiry = Date.now() + ttlSeconds * 1000;
    this.entries.set(key, expiry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) {
        this.entries.delete(key);
      }
    }
  }
}

class MemoryStoreNoDelete implements IdempotencyStore {
  public lastPutTtl: number | null = null;
  private readonly entries = new Set<string>();

  async exists(key: string): Promise<boolean> {
    return this.entries.has(key);
  }

  async put(key: string, ttlSeconds: number): Promise<void> {
    this.lastPutTtl = ttlSeconds;
    this.entries.add(key);
  }
}

describe('executeWithIdempotency', () => {
  it('runs the handler once and skips subsequent duplicates', async () => {
    const store = new MemoryStore();
    const execute = vi.fn(async () => 'ok');
    const onDuplicate = vi.fn();

    const first = await executeWithIdempotency({
      store,
      key: 'job-1',
      ttlSeconds: 30,
      execute,
    });
    expect(first).toMatchObject({ status: 'executed', result: 'ok' });

    const second = await executeWithIdempotency({
      store,
      key: 'job-1',
      ttlSeconds: 30,
      execute,
      onDuplicate,
    });
    expect(second).toMatchObject({ status: 'skipped' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it('releases reservations when the handler throws and no delete is available', async () => {
    const store = new MemoryStoreNoDelete();
    const error = new Error('boom');
    const onError = vi.fn();

    await expect(
      executeWithIdempotency({
        store,
        key: 'job-2',
        ttlSeconds: 60,
        execute: async () => {
          throw error;
        },
        onError,
      }),
    ).rejects.toThrow(error);

    expect(store.lastPutTtl).toBe(1);
    expect(onError).toHaveBeenCalledWith(error);
  });
}
