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
  purgeExpired(now = this.clock()): void {
    if (this.ttlMs === null) {
      return;
    }

    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /** Remove all cached entries. */
  clear(): void {
    this.store.clear();
  }
}

export default InMemoryFeatureStore;

export * from './drift';
