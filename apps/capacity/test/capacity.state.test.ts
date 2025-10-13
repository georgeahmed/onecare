import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelemetryState, ForecastState, ShapedState, AppliedState } from '../src/application/capacity.state';
import { logger } from '@onecare/observability';
import { SchedulerReleaseExecutor } from '../src/adapters/scheduler';
import { InMemoryCapacityScheduler } from '../src/adapters/scheduler.memory';
import { forecastNeedVsSupply } from '../src/application/forecast';
import type {
  CapacityContext,
  CapacityEvent,
  TelemetrySource,
  CapacityAuditor,
  TelemetrySnapshot,
} from '../src/application/types';
import type { ResolvedConfig } from '@onecare/config';
import type { IdempotencyStore } from '@onecare/ports';

const tickEvent: CapacityEvent = { type: 'capacity.tick' };

beforeEach(() => {
  vi.restoreAllMocks();
});

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, boolean>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string) => {
      keys.set(key, true);
    },
    reserve: async (key: string) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, true);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

describe('TelemetryState', () => {
  it('collects telemetry snapshot from source', async () => {
    const telemetrySource = createTelemetrySource({
      arrivalsPerHour: 14,
      queueDepth: 6,
      noShowRate: 0.08,
      staffingLevel: 9,
    });
    const ctx = buildContext({ telemetrySource });
    const state = new TelemetryState();

    const next = await state.handle(ctx, tickEvent);

    expect(next).toBe('Forecast');
    expect(ctx.telemetry).toMatchObject({
      arrivalsPerHour: 14,
      queueDepth: 6,
      noShowRate: 0.08,
      staffingLevel: 9,
    });
    expect((telemetrySource.getArrivalsPerHour as unknown as vi.Mock).mock.calls).toHaveLength(1);
    expect((telemetrySource.getQueueDepth as unknown as vi.Mock).mock.calls).toHaveLength(1);
    expect((telemetrySource.getNoShowRate as unknown as vi.Mock).mock.calls).toHaveLength(1);
    expect((telemetrySource.getStaffingLevel as unknown as vi.Mock).mock.calls).toHaveLength(1);
  });

  it('records unhealthy status and emits metric', async () => {
    const telemetrySource = {
      ...createTelemetrySource({
        arrivalsPerHour: 10,
        queueDepth: 8,
        noShowRate: 0.2,
        staffingLevel: 6,
      }),
      health: vi.fn(async () => ({ ok: false, reason: 'stale' })),
    } as unknown as TelemetrySource;
    const ctx = buildContext({ telemetrySource });
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const state = new TelemetryState();

    await state.handle(ctx, tickEvent);

    expect(ctx.telemetryHealth?.ok).toBe(false);
    expect(ctx.telemetryHealth?.reason).toBe('stale');
    expect(infoSpy).toHaveBeenCalledWith(
      'metric.capacity.telemetry.health',
      expect.objectContaining({ ok: false, reason: 'stale' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'capacity.telemetry.unhealthy',
      expect.objectContaining({ reason: 'stale' }),
    );
  });

  it('degrades gracefully when telemetry collection fails', async () => {
    const telemetrySource = {
      getArrivalsPerHour: vi.fn(async () => {
        throw new Error('telemetry timeout');
      }),
      getQueueDepth: vi.fn(async () => 7),
      getNoShowRate: vi.fn(async () => 0.12),
      getStaffingLevel: vi.fn(async () => 6),
      health: vi.fn(async () => ({ ok: true })),
    } as unknown as TelemetrySource;
    const clock = () => new Date('2025-03-01T10:00:00Z');
    const ctx = buildContext({ telemetrySource, clock });
    const state = new TelemetryState();
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const next = await state.handle(ctx, tickEvent);

    expect(next).toBe('Forecast');
    expect(ctx.telemetryHealth?.ok).toBe(false);
    expect(ctx.telemetryHealth?.reason).toBe('telemetry timeout');
    expect(ctx.telemetry).toEqual({
      arrivalsPerHour: 0,
      queueDepth: 0,
      noShowRate: 0,
      staffingLevel: 0,
      collectedAt: '2025-03-01T10:00:00.000Z',
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'capacity.telemetry.collect_failed',
      expect.objectContaining({ reason: 'telemetry timeout' }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'metric.capacity.telemetry.health',
      expect.objectContaining({ ok: false, reason: 'telemetry timeout' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'capacity.telemetry.unhealthy',
      expect.objectContaining({ reason: 'telemetry timeout' }),
    );
  });
});

describe('forecastNeedVsSupply', () => {
  it('projects positive delta when need exceeds supply', () => {
    const snapshot: TelemetrySnapshot = {
      arrivalsPerHour: 20,
      queueDepth: 15,
      noShowRate: 0.1,
      staffingLevel: 8,
      collectedAt: '2025-01-01T00:00:00Z',
    };

    const result = forecastNeedVsSupply(snapshot, { horizonMinutes: 120 });

    expect(result.delta).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.band.upper).toBeGreaterThan(result.band.lower);
    expect(result.need).toBeGreaterThan(0);
    expect(result.supply).toBeGreaterThan(0);
  });
});

describe('Capacity micro-release decision', () => {
  it('releases bounded plan when thresholds exceeded', async () => {
    const scheduler = new InMemoryCapacityScheduler({ totalSlots: 120, heldSlots: 12 });
    const record = vi.fn(async () => {});
    const auditor: CapacityAuditor = { record };
    const executor = new SchedulerReleaseExecutor(scheduler, {
      reason: 'forecast_delta',
      clock: () => new Date('2025-01-01T00:00:00Z'),
    });
    const ctx = buildContext({
      releaseExecutor: executor,
      auditor,
      capacityWindow: { totalSlots: 120, heldSlots: 12 },
    });
    ctx.forecast = {
      delta: 6,
      confidence: 0.82,
      band: { lower: 4, upper: 8 },
      horizonMinutes: 120,
      need: 66,
      supply: 60,
    };

    const shaped = new ShapedState();
    const nextState = await shaped.handle(ctx, tickEvent);

    expect(nextState).toBe('Applied');
    expect(ctx.decision?.outcome).toBe('release');
    expect(ctx.decision?.plan.slotsToRelease).toBe(6);
    expect(ctx.decision?.plan.heldSlotsAfter).toBe(6);
    expect(ctx.decision?.plan.cappedBy).toEqual(['delta']);

    const applied = new AppliedState();
    const terminal = await applied.handle(ctx, tickEvent);

    expect(terminal).toBe('Applied');
    expect(scheduler.requests).toHaveLength(1);
    const request = scheduler.requests[0];
    expect(request.slots).toBe(6);
    expect(request.dryRun).toBe(false);
    expect(request.plan.heldSlotsAfter).toBe(6);
    expect(request.plan.heldSlotsAfter).toBe(ctx.decision?.plan.heldSlotsAfter);
    const recordMock = record as unknown as vi.Mock;
    expect(recordMock).toHaveBeenCalledTimes(1);
    const auditPayload = recordMock.mock.calls[0][0];
    expect(auditPayload.release.slots).toBe(6);
    expect(auditPayload.outcome).toBe('release');
    expect(ctx.capacityWindow.heldSlots).toBe(6);
    expect(scheduler.snapshot().heldSlots).toBe(6);
  });

  it('skips release when delta below threshold', async () => {
    const scheduler = new InMemoryCapacityScheduler({ totalSlots: 100, heldSlots: 10 });
    const executor = new SchedulerReleaseExecutor(scheduler, { reason: 'forecast_delta' });
    const ctx = buildContext({
      releaseExecutor: executor,
      capacityWindow: { totalSlots: 100, heldSlots: 10 },
    });
    ctx.forecast = {
      delta: 1.5,
      confidence: 0.9,
      band: { lower: 0.5, upper: 2.5 },
      horizonMinutes: 120,
      need: 52,
      supply: 50.5,
    };

    const shaped = new ShapedState();
    await shaped.handle(ctx, tickEvent);

    expect(ctx.decision?.outcome).toBe('skip');
    expect(ctx.decision?.reason).toBe('delta_below_threshold');
    expect(ctx.decision?.plan.slotsToRelease).toBe(0);

    const applied = new AppliedState();
    await applied.handle(ctx, tickEvent);

    expect(scheduler.requests).toHaveLength(0);
    const recordMock = ctx.auditor?.record as unknown as vi.Mock;
    expect(recordMock).toHaveBeenCalledTimes(1);
    const auditPayload = recordMock.mock.calls[0][0];
    expect(auditPayload.outcome).toBe('skip');
    expect(auditPayload.release.slots).toBe(0);
  });

  it('honours dry-run mode without executing release', async () => {
    const scheduler = new InMemoryCapacityScheduler({ totalSlots: 80, heldSlots: 8 });
    const record = vi.fn(async () => {});
    const auditor: CapacityAuditor = { record };
    const executor = new SchedulerReleaseExecutor(scheduler, { reason: 'forecast_delta' });
    const ctx = buildContext({
      releaseExecutor: executor,
      auditor,
      dryRun: true,
      capacityWindow: { totalSlots: 80, heldSlots: 8 },
    });
    ctx.forecast = {
      delta: 5,
      confidence: 0.85,
      band: { lower: 3, upper: 7 },
      horizonMinutes: 120,
      need: 45,
      supply: 40,
    };

    const shaped = new ShapedState();
    await shaped.handle(ctx, tickEvent);
    expect(ctx.decision?.outcome).toBe('release');
    expect(ctx.decision?.plan.slotsToRelease).toBeGreaterThan(0);

    const applied = new AppliedState();
    await applied.handle(ctx, tickEvent);

    expect(scheduler.snapshot().heldSlots).toBe(8);
    expect(scheduler.requests).toHaveLength(0);
    const recordMock = record as unknown as vi.Mock;
    expect(recordMock).toHaveBeenCalledTimes(1);
    const auditPayload = recordMock.mock.calls[0][0];
    expect(auditPayload.dryRun).toBe(true);
    expect(auditPayload.release.slots).toBeGreaterThan(0);
    expect(ctx.capacityWindow.heldSlots).toBe(8);
  });

  it('suppresses duplicate release execution and audit when idempotency keys repeat', async () => {
    const releaseApply = vi.fn(async () => {});
    const auditorRecord = vi.fn(async () => {});
    const store = createIdempotencyStore();

    const ctx = buildContext({
      releaseExecutor: { apply: releaseApply },
      auditor: { record: auditorRecord },
      capacityWindow: { totalSlots: 40, heldSlots: 10 },
      idempotencyStore: store,
      releaseIdempotencyKey: 'capacity:release:demo',
      auditIdempotencyKey: 'capacity:audit:demo',
    });

    ctx.forecast = {
      delta: 6,
      confidence: 0.8,
      band: { lower: 4, upper: 8 },
      horizonMinutes: 120,
      need: 32,
      supply: 26,
    };
    ctx.decision = {
      outcome: 'release',
      reason: 'release_authorized',
      plan: {
        slotsToRelease: 4,
        releaseFraction: 0.2,
        heldSlotsBefore: 10,
        heldSlotsAfter: 6,
        maxFractionSlots: 4,
        minReserveSlots: 2,
        cappedBy: ['delta'],
      },
      deltaThreshold: 3,
      confidenceThreshold: 0.6,
      forecastDelta: 6,
      forecastConfidence: 0.8,
    };

    const applied = new AppliedState();
    await applied.handle(ctx, tickEvent);

    expect(releaseApply).toHaveBeenCalledTimes(1);
    expect(auditorRecord).toHaveBeenCalledTimes(1);

    const duplicateCtx: CapacityContext = {
      ...ctx,
      id: 'run-duplicate',
      capacityWindow: { ...ctx.capacityWindow },
    };

    await applied.handle(duplicateCtx, tickEvent);

    expect(releaseApply).toHaveBeenCalledTimes(1);
    expect(auditorRecord).toHaveBeenCalledTimes(1);
  });

  it('skips release when telemetry health is unhealthy', async () => {
    const scheduler = new InMemoryCapacityScheduler({ totalSlots: 100, heldSlots: 12 });
    const executor = new SchedulerReleaseExecutor(scheduler, { reason: 'forecast_delta' });
    const telemetrySource = {
      ...createTelemetrySource({ arrivalsPerHour: 18, queueDepth: 14, noShowRate: 0.12, staffingLevel: 9 }),
      health: vi.fn(async () => ({ ok: false, reason: 'unreachable' })),
    } as unknown as TelemetrySource;
    const ctx = buildContext({
      releaseExecutor: executor,
      telemetrySource,
      capacityWindow: { totalSlots: 100, heldSlots: 12 },
    });
    const telemetryState = new TelemetryState();
    const forecastState = new ForecastState();
    const shapedState = new ShapedState();
    const appliedState = new AppliedState();

    await telemetryState.handle(ctx, tickEvent);
    await forecastState.handle(ctx, tickEvent);
    const next = await shapedState.handle(ctx, tickEvent);

    expect(next).toBe('Applied');
    expect(ctx.decision?.outcome).toBe('skip');
    expect(ctx.decision?.reason).toBe('telemetry_unhealthy');
    expect(ctx.decision?.plan.slotsToRelease).toBe(0);

    await appliedState.handle(ctx, tickEvent);
    expect(scheduler.requests).toHaveLength(0);
    expect(ctx.capacityWindow.heldSlots).toBe(12);
  });

  it('caps release when forecast delta exceeds configured maximum', async () => {
    const scheduler = new InMemoryCapacityScheduler({ totalSlots: 200, heldSlots: 30 });
    const executor = new SchedulerReleaseExecutor(scheduler, { reason: 'forecast_delta' });
    const ctx = buildContext({
      releaseExecutor: executor,
      capacityWindow: { totalSlots: 200, heldSlots: 30 },
    });
    ctx.forecast = {
      delta: 60,
      confidence: 0.92,
      band: { lower: 45, upper: 75 },
      horizonMinutes: 180,
      need: 180,
      supply: 120,
    };

    const shaped = new ShapedState();
    await shaped.handle(ctx, tickEvent);

    expect(ctx.decision?.outcome).toBe('release');
    expect(ctx.decision?.plan.slotsToRelease).toBe(10);
    expect(ctx.decision?.plan.cappedBy).toContain('maxFraction');
    expect(ctx.decision?.plan.releaseFraction).toBeCloseTo(0.05, 2);

    const applied = new AppliedState();
    await applied.handle(ctx, tickEvent);

    expect(scheduler.requests).toHaveLength(1);
    expect(scheduler.requests[0].slots).toBe(10);
  });
});

function buildContext(overrides: Partial<CapacityContext> = {}): CapacityContext {
  const hasConfigOverride = Object.prototype.hasOwnProperty.call(overrides, 'config');
  const config: ResolvedConfig =
    (hasConfigOverride ? overrides.config : undefined) ??
    ({
      practiceId: overrides.practiceId ?? 'demo',
      hold_back_fraction: 0.1,
      release_max_fraction: 0.05,
      release_delta_threshold: 3,
      release_confidence_threshold: 0.6,
      release_min_hold_fraction: 0.04,
    } as unknown as ResolvedConfig);

  const telemetrySource =
    overrides.telemetrySource ?? createTelemetrySource();

  const context: CapacityContext = {
    id: overrides.id ?? 'run-1',
    practiceId: overrides.practiceId ?? 'demo',
    correlationId: overrides.correlationId ?? 'corr-1',
    config,
    telemetrySource,
    capacityWindow: overrides.capacityWindow ?? { totalSlots: 120, heldSlots: 12 },
    releaseExecutor: overrides.releaseExecutor,
    auditor:
      overrides.auditor ??
      ({
        record: vi.fn(async () => {}),
      } as CapacityAuditor),
    dryRun: overrides.dryRun ?? false,
    forecastHorizonMinutes: overrides.forecastHorizonMinutes,
    clock: overrides.clock ?? (() => new Date('2025-01-01T00:00:00Z')),
    telemetry: overrides.telemetry,
    forecast: overrides.forecast,
    decision: overrides.decision,
    idempotencyStore: overrides.idempotencyStore,
    idempotencyTtlSeconds: overrides.idempotencyTtlSeconds,
    releaseIdempotencyKey: overrides.releaseIdempotencyKey,
    auditIdempotencyKey: overrides.auditIdempotencyKey,
  };

  context.config.practiceId = context.practiceId;
  return context;
}

type TelemetryOverrides = Partial<{
  arrivalsPerHour: number;
  queueDepth: number;
  noShowRate: number;
  staffingLevel: number;
}>;

function createTelemetrySource(overrides: TelemetryOverrides = {}): TelemetrySource {
  return {
    getArrivalsPerHour: vi.fn(async () => overrides.arrivalsPerHour ?? 12),
    getQueueDepth: vi.fn(async () => overrides.queueDepth ?? 5),
    getNoShowRate: vi.fn(async () => overrides.noShowRate ?? 0.12),
    getStaffingLevel: vi.fn(async () => overrides.staffingLevel ?? 7),
  };
}
