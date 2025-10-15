import type {
  FeatureStoreHealth,
  FeatureStoreReadiness,
  OnlineFeatureQuery,
  OnlineFeatureRecord,
  OnlineFeatureStore,
} from '@onecare/ports';

const clone = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

interface StoredVersion {
  asOf: number;
  payload: Record<string, unknown>;
  expiresAt: number | null;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

type EntityKey = `${string}::${string}`;

const makeKey = (featureSet: string, entityId: string): EntityKey => `${featureSet}::${entityId}`;

function purgeExpiredVersions(versions: StoredVersion[], now: number): StoredVersion[] {
  return versions.filter((version) => version.expiresAt === null || now < version.expiresAt);
}

export interface InMemoryOnlineFeatureStoreOptions {
  clock?: () => number;
}

export class InMemoryOnlineFeatureStore implements OnlineFeatureStore {
  private readonly clock: () => number;

  private readonly store = new Map<EntityKey, StoredVersion[]>();

  private lastHealth: FeatureStoreHealth = {
    status: 'ok',
    checkedAt: new Date().toISOString(),
  };

  private lastReadiness: FeatureStoreReadiness = {
    ready: true,
    checkedAt: new Date().toISOString(),
  };

  constructor(options: InMemoryOnlineFeatureStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  async upsert(record: OnlineFeatureRecord): Promise<void> {
    if (!record.featureSet) throw new Error('featureSet is required for online feature store records.');
    if (!record.entityId) throw new Error('entityId is required for online feature store records.');
    const asOf = Date.parse(record.asOf);
    if (Number.isNaN(asOf)) {
      throw new Error(`Invalid asOf timestamp: ${record.asOf}`);
    }
    const now = this.clock();
    const ttlMs = typeof record.ttlSeconds === 'number' ? Math.max(record.ttlSeconds * 1000, 0) : null;
    const expiresAt = ttlMs === null ? null : now + ttlMs;
    const key = makeKey(record.featureSet, record.entityId);
    const existing = this.store.get(key) ?? [];
    const withoutExpired = purgeExpiredVersions(existing, now).filter((version) => version.asOf !== asOf);
    withoutExpired.push({
      asOf,
      payload: clone(record.payload),
      expiresAt,
      correlationId: record.correlationId,
      metadata: record.metadata ? clone(record.metadata) : undefined,
    });
    withoutExpired.sort((a, b) => a.asOf - b.asOf);
    this.store.set(key, withoutExpired);
  }

  async batchUpsert(records: OnlineFeatureRecord[]): Promise<void> {
    for (const record of records) {
      // eslint-disable-next-line no-await-in-loop
      await this.upsert(record);
    }
  }

  async get(query: OnlineFeatureQuery): Promise<Record<string, unknown> | null> {
    const key = makeKey(query.featureSet, query.entityId);
    const versions = this.store.get(key);
    if (!versions) {
      return null;
    }

    const now = this.clock();
    const cleaned = purgeExpiredVersions(versions, now);
    if (cleaned.length !== versions.length) {
      this.store.set(key, cleaned);
    }
    if (cleaned.length === 0) {
      return null;
    }

    if (!query.asOf) {
      const latest = cleaned[cleaned.length - 1]!;
      return clone(latest.payload);
    }

    const asOfTs = Date.parse(query.asOf);
    if (Number.isNaN(asOfTs)) {
      throw new Error(`Invalid asOf timestamp: ${query.asOf}`);
    }

    for (let idx = cleaned.length - 1; idx >= 0; idx -= 1) {
      const candidate = cleaned[idx]!;
      if (candidate.asOf <= asOfTs) {
        return clone(candidate.payload);
      }
    }
    return null;
  }

  async getMany(queries: OnlineFeatureQuery[]): Promise<(Record<string, unknown> | null)[]> {
    const results: (Record<string, unknown> | null)[] = [];
    for (const query of queries) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.get(query));
    }
    return results;
  }

  async delete(featureSet: string, entityId: string): Promise<void> {
    const key = makeKey(featureSet, entityId);
    this.store.delete(key);
  }

  purgeExpired(now = this.clock()): number {
    let removed = 0;
    for (const [key, versions] of this.store.entries()) {
      const cleaned = purgeExpiredVersions(versions, now);
      if (cleaned.length === 0) {
        removed += versions.length;
        this.store.delete(key);
        continue;
      }
      if (cleaned.length !== versions.length) {
        removed += versions.length - cleaned.length;
        this.store.set(key, cleaned);
      }
    }
    return removed;
  }

  async health(): Promise<FeatureStoreHealth> {
    this.lastHealth = {
      status: 'ok',
      checkedAt: new Date(this.clock()).toISOString(),
    };
    return this.lastHealth;
  }

  async readiness(): Promise<FeatureStoreReadiness> {
    this.lastReadiness = {
      ready: true,
      checkedAt: new Date(this.clock()).toISOString(),
    };
    return this.lastReadiness;
  }
}
