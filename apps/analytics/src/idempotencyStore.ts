import type { IdempotencyStore } from '@onecare/ports';

type StoreEntry = { expiresAt: number };
const PRUNE_BATCH_SIZE = 64;

export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, StoreEntry>();
  let pruneIterator: Iterator<[string, StoreEntry]> | null = null;

  const pruneExpired = (now: number): void => {
    if (entries.size === 0) {
      pruneIterator = null;
      return;
    }
    if (!pruneIterator) {
      pruneIterator = entries.entries();
    }
    let processed = 0;
    while (processed < PRUNE_BATCH_SIZE) {
      const next = pruneIterator.next();
      if (next.done) {
        pruneIterator = entries.entries();
        break;
      }
      const [key, entry] = next.value;
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
      processed += 1;
    }
    if (entries.size === 0) {
      pruneIterator = null;
    }
  };

  const toExpiresAt = (ttlSeconds: number, now: number): number => {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return now;
    }
    return now + Math.floor(ttlSeconds * 1000);
  };

  return {
    async exists(key: string): Promise<boolean> {
      const now = Date.now();
      pruneExpired(now);
      const entry = entries.get(key);
      return Boolean(entry && entry.expiresAt > now);
    },
    async put(key: string, ttlSeconds: number): Promise<void> {
      const now = Date.now();
      pruneExpired(now);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        entries.delete(key);
        return;
      }
      entries.set(key, { expiresAt: toExpiresAt(ttlSeconds, now) });
    },
    async reserve(key: string, ttlSeconds: number): Promise<'reserved' | 'exists'> {
      const now = Date.now();
      pruneExpired(now);
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now) {
        entries.set(key, { expiresAt: toExpiresAt(ttlSeconds, now) });
        return 'exists';
      }
      entries.set(key, { expiresAt: toExpiresAt(ttlSeconds, now) });
      return 'reserved';
    },
    async delete(key: string): Promise<void> {
      entries.delete(key);
    },
  };
}
