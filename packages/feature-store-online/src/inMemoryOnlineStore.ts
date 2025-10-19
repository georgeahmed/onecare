import type {
  FeatureStoreHealth,
  FeatureStoreReadiness,
  OnlineFeatureQuery,
  OnlineFeatureRecord,
  OnlineFeatureStore,
} from '@onecare/ports';
import { createCounter, createGauge, createHistogram } from '@onecare/observability';

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

const getLatencyHistogram = createHistogram('features.online.get_latency_ms');
const getCounter = createCounter('features.online.get_total');
const getHitCounter = createCounter('features.online.get_hit');
const getMissCounter = createCounter('features.online.get_miss');
const cacheHitGauge = createGauge('features.online.hit_ratio');

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

  private hitCount = 0;
  private missCount = 0;

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
    const start = Date.now();
    getCounter.add(1, { featureSet: query.featureSet });
    const key = makeKey(query.featureSet, query.entityId);
    const versions = this.store.get(key);
    if (!versions) {
      this.recordMiss(query.featureSet);
      getLatencyHistogram.record(Date.now() - start, { featureSet: query.featureSet, hit: 'false' });
      return null;
    }

    const now = this.clock();
    const cleaned = purgeExpiredVersions(versions, now);
    if (cleaned.length !== versions.length) {
      this.store.set(key, cleaned);
    }
    if (cleaned.length === 0) {
      this.recordMiss(query.featureSet);
      getLatencyHistogram.record(Date.now() - start, { featureSet: query.featureSet, hit: 'false' });
      return null;
    }

    if (!query.asOf) {
      const latest = cleaned[cleaned.length - 1]!;
      this.recordHit(query.featureSet);
      getLatencyHistogram.record(Date.now() - start, { featureSet: query.featureSet, hit: 'true' });
      return clone(latest.payload);
    }

    const asOfTs = Date.parse(query.asOf);
    if (Number.isNaN(asOfTs)) {
      throw new Error(`Invalid asOf timestamp: ${query.asOf}`);
    }

    for (let idx = cleaned.length - 1; idx >= 0; idx -= 1) {
      const candidate = cleaned[idx]!;
      if (candidate.asOf <= asOfTs) {
        this.recordHit(query.featureSet);
        getLatencyHistogram.record(Date.now() - start, { featureSet: query.featureSet, hit: 'true' });
        return clone(candidate.payload);
      }
    }
    this.recordMiss(query.featureSet);
    getLatencyHistogram.record(Date.now() - start, { featureSet: query.featureSet, hit: 'false' });
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
    const total = this.hitCount + this.missCount;
    const hitRatio = total > 0 ? this.hitCount / total : 1;
    this.lastHealth = {
      status: 'ok',
      checkedAt: new Date(this.clock()).toISOString(),
      details: `hitRatio=${hitRatio.toFixed(3)}`,
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

  private recordHit(featureSet: string): void {
    this.hitCount += 1;
    getHitCounter.add(1, { featureSet });
    this.updateHitGauge();
  }

  private recordMiss(featureSet: string): void {
    this.missCount += 1;
    getMissCounter.add(1, { featureSet });
    this.updateHitGauge();
  }

  private updateHitGauge(): void {
    const total = this.hitCount + this.missCount;
    if (total === 0) {
      cacheHitGauge.set(1, { store: 'in-memory' });
      return;
    }
    const ratio = this.hitCount / total;
    cacheHitGauge.set(ratio, { store: 'in-memory' });
  }
}
