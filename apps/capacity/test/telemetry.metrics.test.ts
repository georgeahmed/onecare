import { describe, it, expect, beforeEach } from 'vitest';
import {
  OperationalTelemetryRepository,
  MetricsTelemetrySource,
  createOperationalTelemetrySource,
  recordArrival,
  recordQueueDepth,
  recordAppointmentOutcome,
  recordStaffingLevel,
  defaultOperationalTelemetryRepository,
  overrideTelemetryHealth,
  computeAdaptiveTtl,
} from '../src/adapters/telemetry.metrics';

describe('OperationalTelemetryRepository', () => {
  let repo: OperationalTelemetryRepository;
  let now: () => number;
  let nowValue: number;

  beforeEach(() => {
    repo = new OperationalTelemetryRepository();
    nowValue = Date.now();
    now = () => nowValue;
  });

  it('computes arrivals per hour within window', () => {
    repo.recordArrivals(5, now());
    nowValue += 10 * 60 * 1_000;
    repo.recordArrivals(3, now());

    const rate = repo.getArrivalsPerHour(now());
    expect(rate).toBeGreaterThan(7);
  });

  it('degrades queue depth when stale', () => {
    repo.setQueueDepth(12, now());
    nowValue += 20 * 60 * 1_000;
    expect(repo.getQueueDepth(now())).toBe(12);
    nowValue += 20 * 60 * 1_000;
    expect(repo.getQueueDepth(now())).toBe(0);
  });

  it('estimates volatility from arrivals and queue', () => {
    repo.recordArrivals(20, now());
    repo.setQueueDepth(15, now());
    const volatility = repo.estimateVolatility(now());
    expect(volatility).toBeGreaterThan(0);
  });

  it('honours explicit health override', () => {
    repo.setHealthOverride({ ok: false, reason: 'manual', checkedAt: '2025-01-01T00:00:00Z' });
    expect(repo.getHealth()).toEqual({ ok: false, reason: 'manual', checkedAt: '2025-01-01T00:00:00Z' });
  });
});

describe('MetricsTelemetrySource', () => {
  it('reads metrics from repository', async () => {
    const repo = new OperationalTelemetryRepository();
    repo.recordArrivals(4);
    repo.setQueueDepth(9);
    repo.recordAppointment(false);
    repo.setStaffingLevel(7);

    const source = new MetricsTelemetrySource(repo);
    expect(await source.getQueueDepth()).toBe(9);
    expect(await source.getStaffingLevel()).toBe(7);
    expect(await source.getNoShowRate()).toBeCloseTo(0, 3);
  });
});

describe('createOperationalTelemetrySource', () => {
  beforeEach(() => {
    defaultOperationalTelemetryRepository.reset();
  });

  it('adapts TTL based on volatility', () => {
    const highVolatilityTtl = computeAdaptiveTtl(0.95, 5_000, 60_000);
    const lowVolatilityTtl = computeAdaptiveTtl(0.1, 5_000, 60_000);

    expect(highVolatilityTtl).toBeGreaterThanOrEqual(5_000);
    expect(highVolatilityTtl).toBeLessThanOrEqual(10_000);
    expect(lowVolatilityTtl).toBeGreaterThan(50_000);
  });

  it('exposes helper recorders for default repository', async () => {
    const nowValue = Date.now();
    const now = () => nowValue;
    const source = createOperationalTelemetrySource(defaultOperationalTelemetryRepository, { now });

    recordArrival(5, now());
    recordQueueDepth(11, now());
    recordStaffingLevel(6, now());
    recordAppointmentOutcome(true, now());

    const snapshot = await source.getArrivalsPerHour();
    expect(snapshot).toBeGreaterThan(0);
    expect(await source.getQueueDepth()).toBe(11);
    expect(await source.getStaffingLevel()).toBe(6);
    expect(await source.getNoShowRate()).toBeGreaterThan(0);

    overrideTelemetryHealth({ ok: false, reason: 'manual' });
    const health = await source.health();
    expect(health.ok).toBe(false);
    overrideTelemetryHealth(null);
  });
});
