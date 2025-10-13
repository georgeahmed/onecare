import type { TelemetryHealth, TelemetrySource } from '../application/types';
import { CachedTelemetrySource } from '../application/telemetry';

interface ArrivalRecord {
  timestamp: number;
  count: number;
}

interface LevelRecord {
  value: number;
  timestamp: number;
}

const ARRIVAL_WINDOW_MS = 60 * 60 * 1_000;
const MIN_WINDOW_MS = 5 * 60 * 1_000;
const STALE_WINDOW_MS = 30 * 60 * 1_000;

export class OperationalTelemetryRepository {
  private arrivals: ArrivalRecord[] = [];
  private appointmentsTotal = 0;
  private appointmentsNoShow = 0;
  private appointmentsUpdatedAt = 0;
  private queueDepth: LevelRecord = { value: 0, timestamp: 0 };
  private previousQueueDepth = 0;
  private staffingLevel: LevelRecord = { value: 0, timestamp: 0 };
  private healthOverride: TelemetryHealth | null = null;

  recordArrivals(count = 1, timestamp = Date.now()): void {
    const safeCount = Math.max(0, count);
    this.arrivals.push({ timestamp, count: safeCount });
    this.pruneArrivals(timestamp);
  }

  setQueueDepth(depth: number, timestamp = Date.now()): void {
    this.previousQueueDepth = this.queueDepth.value;
    this.queueDepth = { value: Math.max(0, depth), timestamp };
  }

  recordAppointment(noShow: boolean, timestamp = Date.now()): void {
    this.appointmentsTotal += 1;
    if (noShow) this.appointmentsNoShow += 1;
    this.appointmentsUpdatedAt = timestamp;
  }

  setStaffingLevel(level: number, timestamp = Date.now()): void {
    this.staffingLevel = { value: Math.max(0, level), timestamp };
  }

  setHealthOverride(health: TelemetryHealth | null): void {
    this.healthOverride = health;
  }

  getArrivalsPerHour(now = Date.now()): number {
    this.pruneArrivals(now);
    if (this.arrivals.length === 0) return 0;
    const total = this.arrivals.reduce((sum, record) => sum + record.count, 0);
    const duration = Math.max(MIN_WINDOW_MS, now - this.arrivals[0].timestamp);
    return (total * 60 * 60 * 1_000) / duration;
  }

  getQueueDepth(now = Date.now()): number {
    if (now - this.queueDepth.timestamp > STALE_WINDOW_MS) {
      return 0;
    }
    return this.queueDepth.value;
  }

  getNoShowRate(now = Date.now()): number {
    if (this.appointmentsTotal === 0) {
      return 0.08;
    }
    if (now - this.appointmentsUpdatedAt > STALE_WINDOW_MS) {
      return 0.08;
    }
    return clamp(this.appointmentsNoShow / this.appointmentsTotal, 0, 0.5);
  }

  getStaffingLevel(now = Date.now()): number {
    if (now - this.staffingLevel.timestamp > STALE_WINDOW_MS) {
      return 0;
    }
    return this.staffingLevel.value;
  }

  estimateVolatility(now = Date.now()): number {
    const arrivalsRate = this.getArrivalsPerHour(now);
    const queue = this.getQueueDepth(now);
    const arrivalsComponent = Math.min(1, arrivalsRate / 60); // normalize to 60/hr
    const queueComponent = Math.min(1, queue / 25); // assume 25 backlog high
    const delta = Math.abs(queue - this.previousQueueDepth);
    const deltaComponent = Math.min(1, delta / 10);
    return clamp((arrivalsComponent + queueComponent + deltaComponent) / 3, 0, 1);
  }

  getHealth(now = Date.now()): TelemetryHealth {
    if (this.healthOverride) {
      return {
        ...this.healthOverride,
        checkedAt: this.healthOverride.checkedAt ?? new Date(now).toISOString(),
      };
    }
    const arrivalsFresh = this.arrivals.length > 0 && now - this.arrivals[this.arrivals.length - 1].timestamp <= STALE_WINDOW_MS;
    const queueFresh = now - this.queueDepth.timestamp <= STALE_WINDOW_MS;
    const staffingFresh = now - this.staffingLevel.timestamp <= STALE_WINDOW_MS;
    const ok = arrivalsFresh && queueFresh && staffingFresh;
    return {
      ok,
      reason: ok ? undefined : 'telemetry_stale',
      checkedAt: new Date(now).toISOString(),
    };
  }

  reset(): void {
    this.arrivals = [];
    this.appointmentsTotal = 0;
    this.appointmentsNoShow = 0;
    this.appointmentsUpdatedAt = 0;
    this.queueDepth = { value: 0, timestamp: 0 };
    this.previousQueueDepth = 0;
    this.staffingLevel = { value: 0, timestamp: 0 };
    this.healthOverride = null;
  }

  private pruneArrivals(now: number): void {
    const cutoff = now - ARRIVAL_WINDOW_MS;
    while (this.arrivals.length > 0 && this.arrivals[0].timestamp < cutoff) {
      this.arrivals.shift();
    }
  }
}

export class MetricsTelemetrySource implements TelemetrySource {
  constructor(private readonly repository: OperationalTelemetryRepository, private readonly now: () => number = Date.now) {}

  async getArrivalsPerHour(): Promise<number> {
    return this.repository.getArrivalsPerHour(this.now());
  }

  async getQueueDepth(): Promise<number> {
    return this.repository.getQueueDepth(this.now());
  }

  async getNoShowRate(): Promise<number> {
    return this.repository.getNoShowRate(this.now());
  }

  async getStaffingLevel(): Promise<number> {
    return this.repository.getStaffingLevel(this.now());
  }

  async health(): Promise<TelemetryHealth> {
    return this.repository.getHealth(this.now());
  }
}

export interface OperationalTelemetrySourceOptions {
  minTtlMs?: number;
  maxTtlMs?: number;
  now?: () => number;
}

export function createOperationalTelemetrySource(
  repository: OperationalTelemetryRepository,
  options: OperationalTelemetrySourceOptions = {},
): CachedTelemetrySource {
  const minTtl = options.minTtlMs ?? 10_000;
  const maxTtl = options.maxTtlMs ?? 60_000;
  if (minTtl <= 0 || maxTtl <= 0 || maxTtl < minTtl) {
    throw new Error('operational_telemetry_ttl_invalid');
  }
  const now = options.now ?? Date.now;
  const inner = new MetricsTelemetrySource(repository, now);
  const ttlProvider = () => {
    const volatility = repository.estimateVolatility(now());
    return computeAdaptiveTtl(volatility, minTtl, maxTtl);
  };
  return new CachedTelemetrySource(inner, { ttlProvider, now });
}

export function computeAdaptiveTtl(volatility: number, minTtl: number, maxTtl: number): number {
  const bounded = clamp(volatility, 0, 1);
  const adaptive = maxTtl - (maxTtl - minTtl) * bounded;
  return Math.round(adaptive);
}

export const defaultOperationalTelemetryRepository = new OperationalTelemetryRepository();

export function recordArrival(count = 1, timestamp?: number): void {
  defaultOperationalTelemetryRepository.recordArrivals(count, timestamp);
}

export function recordQueueDepth(depth: number, timestamp?: number): void {
  defaultOperationalTelemetryRepository.setQueueDepth(depth, timestamp);
}

export function recordAppointmentOutcome(noShow: boolean, timestamp?: number): void {
  defaultOperationalTelemetryRepository.recordAppointment(noShow, timestamp);
}

export function recordStaffingLevel(level: number, timestamp?: number): void {
  defaultOperationalTelemetryRepository.setStaffingLevel(level, timestamp);
}

export function overrideTelemetryHealth(health: TelemetryHealth | null): void {
  defaultOperationalTelemetryRepository.setHealthOverride(health);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
