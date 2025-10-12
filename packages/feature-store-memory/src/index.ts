import type { FeatureStore } from '@onecare/ports';

export interface InMemoryFeatureStoreOptions {
  /**
   * Global time-to-live (milliseconds) applied to all stored feature rows.
   * When omitted, entries do not expire automatically.
   */
  ttlMs?: number;
  /**
   * Optional clock override (primarily for tests).
   */
  clock?: () => number;
}

type FeatureEntry = {
  value: Record<string, unknown>;
  expiresAt: number | null;
  createdAt: number;
};

const clone = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return globalThis.structuredClone(value);
  }
  // Last resort for environments without structuredClone support.
  return JSON.parse(JSON.stringify(value)) as T;
};

/**
 * Minimal in-memory feature store implementation suitable for unit tests and local dev.
 * Not intended for production use.
 */
export class InMemoryFeatureStore implements FeatureStore {
  private readonly ttlMs: number | null;
  private readonly clock: () => number;
  private readonly store = new Map<string, FeatureEntry>();

  constructor(options: InMemoryFeatureStoreOptions = {}) {
    this.ttlMs = typeof options.ttlMs === 'number' ? Math.max(options.ttlMs, 0) : null;
    this.clock = options.clock ?? Date.now;
  }

  async putFeatures(key: string, features: Record<string, unknown>): Promise<void> {
    if (!key) throw new Error('FeatureStore requires a non-empty key');
    const now = this.clock();
    const expiresAt = this.ttlMs === null ? null : now + this.ttlMs;
    this.store.set(key, {
      value: clone(features),
      expiresAt,
      createdAt: now,
    });
  }

  async getFeatures(key: string): Promise<Record<string, unknown> | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && this.clock() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return clone(entry.value);
  }

  /**
   * Remove expired entries proactively (useful for long-lived test instances).
   */
  purgeExpired(now = this.clock()): number {
    if (this.ttlMs === null) {
      return 0;
    }

    let purged = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.store.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  /**
   * Remove entries that were created before the given retention window.
   * Useful for stores that rely on external retention policies instead of TTL.
   */
  purgeOlderThan(retentionMs: number, now = this.clock()): number {
    if (!Number.isFinite(retentionMs)) {
      return 0;
    }
    const normalizedRetention = retentionMs < 0 ? 0 : retentionMs;
    const cutoff = now - normalizedRetention;
    let purged = 0;
    for (const [key, entry] of this.store.entries()) {
      const createdAt = entry.createdAt ?? 0;
      if (createdAt <= cutoff) {
        this.store.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  /** Remove all cached entries. */
  clear(): void {
    this.store.clear();
  }
}

export default InMemoryFeatureStore;

export * from './drift';
export * from './driftMonitor';
