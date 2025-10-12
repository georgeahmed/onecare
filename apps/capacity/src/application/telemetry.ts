import type { TelemetryHealth, TelemetrySnapshot, TelemetrySource } from './types';

export interface TelemetrySnapshotOptions {
  clock?: () => Date;
}

export async function collectTelemetrySnapshot(
  source: TelemetrySource,
  options: TelemetrySnapshotOptions = {},
): Promise<TelemetrySnapshot> {
  const timestamp = (options.clock ?? defaultClock)().toISOString();
  const [arrivalsPerHour, queueDepth, noShowRate, staffingLevel] = await Promise.all([
    source.getArrivalsPerHour(),
    source.getQueueDepth(),
    source.getNoShowRate(),
    source.getStaffingLevel(),
  ]);

  return {
    arrivalsPerHour: sanitizeNonNegative(arrivalsPerHour),
    queueDepth: sanitizeNonNegative(queueDepth),
    noShowRate: clampNumber(sanitizeNonNegative(noShowRate), 0, 0.95),
    staffingLevel: sanitizeNonNegative(staffingLevel),
    collectedAt: timestamp,
  };
}

export interface CachedTelemetryOptions {
  ttlMs?: number;
  ttlProvider?: (metric: MetricKey) => number;
  now?: () => number;
}

type MetricKey = 'arrivalsPerHour' | 'queueDepth' | 'noShowRate' | 'staffingLevel';

interface CacheEntry {
  value: number;
  expiresAt: number;
}

export class CachedTelemetrySource implements TelemetrySource {
  private readonly ttlMs?: number;
  private readonly ttlProvider?: (metric: MetricKey) => number;
  private readonly now: () => number;
  private readonly cache: Partial<Record<MetricKey, CacheEntry>> = {};

  constructor(private readonly inner: TelemetrySource, options: CachedTelemetryOptions) {
    const ttlMs = options.ttlMs;
    const ttlProvider = options.ttlProvider;
    if (ttlProvider) {
      this.ttlProvider = ttlProvider;
    } else {
      const resolvedTtl = ttlMs ?? 15_000;
      if (resolvedTtl <= 0 || !Number.isFinite(resolvedTtl)) {
        throw new Error('telemetry_cache_ttl_invalid');
      }
      this.ttlMs = resolvedTtl;
    }
    this.now = options.now ?? defaultNow;
  }

  async getArrivalsPerHour(): Promise<number> {
    return this.getWithCache('arrivalsPerHour', () => this.inner.getArrivalsPerHour());
  }

  async getQueueDepth(): Promise<number> {
    return this.getWithCache('queueDepth', () => this.inner.getQueueDepth());
  }

  async getNoShowRate(): Promise<number> {
    return this.getWithCache('noShowRate', () => this.inner.getNoShowRate());
  }

  async getStaffingLevel(): Promise<number> {
    return this.getWithCache('staffingLevel', () => this.inner.getStaffingLevel());
  }

  async health(): Promise<TelemetryHealth | undefined> {
    if (!this.inner.health) return undefined;
    return this.inner.health();
  }

  clear(metric?: MetricKey): void {
    if (metric) {
      delete this.cache[metric];
      return;
    }
    for (const key of Object.keys(this.cache) as MetricKey[]) {
      delete this.cache[key];
    }
  }

  private async getWithCache(metric: MetricKey, resolver: () => Promise<number>): Promise<number> {
    const entry = this.cache[metric];
    const nowMs = this.now();
    if (entry && entry.expiresAt > nowMs) {
      return entry.value;
    }
    const value = await resolver();
    const ttl = this.resolveTtl(metric);
    this.cache[metric] = { value, expiresAt: nowMs + ttl };
    return value;
  }

  private resolveTtl(metric: MetricKey): number {
    if (this.ttlProvider) {
      const dynamic = this.ttlProvider(metric);
      if (!Number.isFinite(dynamic) || dynamic <= 0) {
        throw new Error(`telemetry_cache_ttl_invalid:${metric}`);
      }
      return dynamic;
    }
    return this.ttlMs!;
  }
}

export interface InMemoryTelemetryOptions {
  base: TelemetryValueSet;
  variance?: Partial<TelemetryValueSet>;
  random?: () => number;
  health?: TelemetryHealth;
}

interface TelemetryValueSet {
  arrivalsPerHour: number;
  queueDepth: number;
  noShowRate: number;
  staffingLevel: number;
}

export class InMemoryTelemetrySource implements TelemetrySource {
  private readonly base: TelemetryValueSet;
  private readonly variance: Partial<TelemetryValueSet>;
  private readonly random: () => number;
  private readonly healthStatus?: TelemetryHealth;

  constructor(options: InMemoryTelemetryOptions) {
    this.base = options.base;
    this.variance = options.variance ?? {};
    this.random = options.random ?? Math.random;
    this.healthStatus = options.health;
  }

  async getArrivalsPerHour(): Promise<number> {
    return this.sample('arrivalsPerHour');
  }

  async getQueueDepth(): Promise<number> {
    return this.sample('queueDepth');
  }

  async getNoShowRate(): Promise<number> {
    return this.sample('noShowRate');
  }

  async getStaffingLevel(): Promise<number> {
    return this.sample('staffingLevel');
  }

  async health(): Promise<TelemetryHealth | undefined> {
    return this.healthStatus;
  }

  private sample(key: keyof TelemetryValueSet): number {
    const baseValue = sanitizeNonNegative(this.base[key]);
    const variance = sanitizeNonNegative(this.variance[key] ?? 0);
    if (variance === 0) {
      return baseValue;
    }
    const randomDelta = (this.random() * 2 - 1) * variance;
    const sampled = baseValue + randomDelta;
    if (key === 'noShowRate') {
      return clampNumber(sampled, 0, 0.95);
    }
    return Math.max(0, sampled);
  }
}

function sanitizeNonNegative(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function defaultClock(): Date {
  return new Date();
}

function defaultNow(): number {
  return Date.now();
}
