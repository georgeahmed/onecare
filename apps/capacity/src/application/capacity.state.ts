import { BaseState } from '@onecare/statekit';
import { createCounter, createHistogram, logger, startSpan } from '@onecare/observability';
import { executeWithIdempotency } from '@onecare/ports';
import { forecastNeedVsSupply } from './forecast';
import { collectTelemetrySnapshot } from './telemetry';
import {
  type CapacityContext,
  type CapacityEvent,
  type CapacityAuditRecord,
  type ReleasePlan,
  type ReleaseDecision,
  type ReleaseCap,
  type TelemetryHealth,
  type TelemetrySnapshot,
} from './types';

interface CapacitySettings {
  holdBackFraction: number;
  releaseMaxFraction: number;
  minHoldFraction: number;
  deltaThreshold: number;
  confidenceThreshold: number;
  horizonMinutes: number;
}

const HOLD_BACK_DEFAULT = 0.1;
const HOLD_BACK_MIN = 0;
const HOLD_BACK_MAX = 0.6;
const RELEASE_MAX_DEFAULT = 0.05;
const DELTA_THRESHOLD_DEFAULT = 3;
const CONFIDENCE_THRESHOLD_DEFAULT = 0.6;
const MIN_FORECAST_MINUTES = 30;
const MAX_FORECAST_MINUTES = 8 * 60;
const DEFAULT_CAPACITY_IDEMPOTENCY_TTL_SECONDS = 5 * 60;

export class TelemetryState extends BaseState<CapacityContext, CapacityEvent> {
  constructor() {
    super('Telemetry');
  }

  async handle(ctx: CapacityContext): Promise<string> {
    if (!ctx.telemetrySource) {
      throw new Error('telemetry_source_missing');
    }
    const clock = ctx.clock ?? defaultClock;
    const health = await evaluateTelemetryHealth(ctx.telemetrySource, clock);
    ctx.telemetryHealth = health;

    logger.info('metric.capacity.telemetry.health', {
      practiceId: ctx.practiceId,
      runId: ctx.id,
      ok: health.ok,
      reason: health.reason,
      correlationId: ctx.correlationId,
    });

    if (!health.ok) {
      logger.warn('capacity.telemetry.unhealthy', {
        practiceId: ctx.practiceId,
        runId: ctx.id,
        reason: health.reason ?? 'unknown',
        correlationId: ctx.correlationId,
      });
    }

    let snapshot: TelemetrySnapshot;
    try {
      snapshot = await collectTelemetrySnapshot(ctx.telemetrySource, { clock });
    } catch (error) {
      const reason = normalizeErrorReason(error);
      const degradedHealth: TelemetryHealth = {
        ok: false,
        reason,
        checkedAt: clock().toISOString(),
      };

      const shouldLogDegradedHealth = !ctx.telemetryHealth || ctx.telemetryHealth.ok;
      ctx.telemetryHealth = degradedHealth;

      const logMetadata = {
        practiceId: ctx.practiceId,
        runId: ctx.id,
        reason,
        correlationId: ctx.correlationId,
      };

      logger.error('capacity.telemetry.collect_failed', {
        ...logMetadata,
        dryRun: Boolean(ctx.dryRun),
      });

      if (shouldLogDegradedHealth) {
        logger.info('metric.capacity.telemetry.health', {
          practiceId: ctx.practiceId,
          runId: ctx.id,
          ok: false,
          reason,
          correlationId: ctx.correlationId,
        });
        logger.warn('capacity.telemetry.unhealthy', logMetadata);
      }

      snapshot = buildEmptyTelemetrySnapshot(degradedHealth.checkedAt ?? clock().toISOString());
    }

    ctx.telemetry = snapshot;
    logger.debug('capacity.telemetry.collected', {
      practiceId: ctx.practiceId,
      runId: ctx.id,
      arrivalsPerHour: snapshot.arrivalsPerHour,
      queueDepth: snapshot.queueDepth,
      staffingLevel: snapshot.staffingLevel,
      correlationId: ctx.correlationId,
    });
    return 'Forecast';
  }
}

export class ForecastState extends BaseState<CapacityContext, CapacityEvent> {
  constructor() {
    super('Forecast');
  }

  async handle(ctx: CapacityContext): Promise<string> {
    if (!ctx.telemetry) {
      throw new Error('telemetry_missing');
    }
    const settings = resolveCapacitySettings(ctx);
    const forecast = forecastNeedVsSupply(ctx.telemetry, {
      horizonMinutes: settings.horizonMinutes,
    });
    ctx.forecast = forecast;
    logger.debug('capacity.forecast.generated', {
      practiceId: ctx.practiceId,
      runId: ctx.id,
      delta: forecast.delta,
      confidence: forecast.confidence,
      horizonMinutes: forecast.horizonMinutes,
    });
    return 'Shaped';
  }
}

export class ShapedState extends BaseState<CapacityContext, CapacityEvent> {
  constructor() {
    super('Shaped');
  }

  async handle(ctx: CapacityContext): Promise<string> {
    const span = startSpan('capacity.shape');
    span.setAttributes({
      'capacity.practice_id': ctx.practiceId,
      'capacity.run_id': ctx.id,
    });
    const startedAt = Date.now();
    if (!ctx.forecast) {
      span.end();
      throw new Error('forecast_missing');
    }
    const settings = resolveCapacitySettings(ctx);
    const forecast = ctx.forecast;

    const totalSlots = Math.max(0, ctx.capacityWindow?.totalSlots ?? 0);
    const heldSlots = Math.max(0, ctx.capacityWindow?.heldSlots ?? 0);
    const minReserveSlots = Math.max(
      0,
      Math.ceil(totalSlots * settings.minHoldFraction),
    );
    const maxFractionSlots = Math.max(
      0,
      Math.floor(totalSlots * settings.releaseMaxFraction),
    );

    if (ctx.telemetryHealth && !ctx.telemetryHealth.ok) {
      const plan = buildZeroReleasePlan(heldSlots, totalSlots, maxFractionSlots, minReserveSlots);
      const decision: ReleaseDecision = {
        outcome: 'skip',
        reason: 'telemetry_unhealthy',
        plan,
        deltaThreshold: settings.deltaThreshold,
        confidenceThreshold: settings.confidenceThreshold,
        forecastDelta: forecast.delta,
        forecastConfidence: forecast.confidence,
      };
      ctx.decision = decision;
      logger.warn('capacity.micro_release.decision', {
        component: 'capacity',
        practiceId: ctx.practiceId,
        runId: ctx.id,
        outcome: decision.outcome,
        reason: decision.reason,
        delta: forecast.delta,
        confidence: forecast.confidence,
        releaseSlots: 0,
        dryRun: Boolean(ctx.dryRun),
        correlationId: ctx.correlationId,
      });
      span.setAttributes({
        'capacity.decision.outcome': decision.outcome,
        'capacity.decision.reason': decision.reason,
      });
      span.end();
      return 'Applied';
    }

    let outcome: ReleaseDecision['outcome'] = 'skip';
    let reason = 'delta_below_threshold';
    let releaseSlots = 0;
    const cappedBy: ReleaseCap[] = [];

    if (forecast.delta <= settings.deltaThreshold) {
      reason = 'delta_below_threshold';
    } else if (forecast.confidence < settings.confidenceThreshold) {
      reason = 'confidence_below_threshold';
    } else if (heldSlots <= 0) {
      reason = 'no_held_capacity';
    } else if (maxFractionSlots <= 0) {
      reason = 'max_fraction_ceiling';
    } else {
      const availableHeld = Math.max(0, heldSlots - minReserveSlots);
      if (availableHeld <= 0) {
        reason = 'reserve_floor_reached';
      } else {
        const requiredSlots = Math.ceil(forecast.delta);
        releaseSlots = Math.min(
          requiredSlots,
          availableHeld,
          maxFractionSlots > 0 ? maxFractionSlots : availableHeld,
        );
        releaseSlots = Math.max(0, releaseSlots);
        if (releaseSlots <= 0) {
          reason = 'bounded_to_zero';
        } else {
          outcome = 'release';
          reason = 'release_authorized';
          if (releaseSlots < requiredSlots) {
            if (releaseSlots === maxFractionSlots && maxFractionSlots < requiredSlots) {
              cappedBy.push('maxFraction');
            }
            if (releaseSlots === availableHeld && availableHeld < requiredSlots) {
              cappedBy.push(minReserveSlots > 0 ? 'reserve' : 'held');
            }
          } else {
            cappedBy.push('delta');
          }
        }
      }
    }

    const plan: ReleasePlan = {
      slotsToRelease: releaseSlots,
      releaseFraction: totalSlots > 0 ? releaseSlots / totalSlots : 0,
      heldSlotsBefore: heldSlots,
      heldSlotsAfter: Math.max(0, heldSlots - releaseSlots),
      maxFractionSlots,
      minReserveSlots,
      cappedBy: outcome === 'release' ? dedupeCaps(cappedBy) : [],
    };

    const decision: ReleaseDecision = {
      outcome,
      reason,
      plan,
      deltaThreshold: settings.deltaThreshold,
      confidenceThreshold: settings.confidenceThreshold,
      forecastDelta: forecast.delta,
      forecastConfidence: forecast.confidence,
    };
    ctx.decision = decision;

    logger.info('capacity.micro_release.decision', {
      component: 'capacity',
      practiceId: ctx.practiceId,
      runId: ctx.id,
      outcome,
      reason,
      delta: forecast.delta,
      confidence: forecast.confidence,
      releaseSlots,
      dryRun: Boolean(ctx.dryRun),
      correlationId: ctx.correlationId,
    });
    releaseDecidedCounter.add(1, {
      practiceId: ctx.practiceId,
      outcome,
      reason,
    });
    releaseDurationHistogram.record(Date.now() - startedAt, {
      practiceId: ctx.practiceId,
      outcome,
      reason,
    });
    span.setAttributes({
      'capacity.decision.outcome': outcome,
      'capacity.decision.reason': reason,
      'capacity.decision.release_slots': releaseSlots,
    });
    span.end();

    return 'Applied';
  }
}

export class AppliedState extends BaseState<CapacityContext, CapacityEvent> {
  constructor() {
    super('Applied');
  }

  async handle(ctx: CapacityContext): Promise<string> {
    if (!ctx.decision) {
      throw new Error('release_decision_missing');
    }
    if (!ctx.forecast) {
      throw new Error('forecast_missing');
    }

    const decision = ctx.decision;
    const plan = decision.plan;
    const meta = {
      practiceId: ctx.practiceId,
      runId: ctx.id,
      correlationId: ctx.correlationId,
      dryRun: Boolean(ctx.dryRun),
    };

    if (ctx.shutdownSignal?.aborted) {
      logger.info('capacity.micro_release.shutdown_skip', {
        practiceId: ctx.practiceId,
        runId: ctx.id,
        correlationId: ctx.correlationId,
      });
      return 'Applied';
    }

    if (decision.outcome === 'release' && plan.slotsToRelease > 0) {
      if (ctx.dryRun) {
        logger.info('capacity.micro_release.dry_run', {
          practiceId: ctx.practiceId,
          runId: ctx.id,
          slots: plan.slotsToRelease,
        });
      } else {
        if (!ctx.releaseExecutor) {
          throw new Error('release_executor_missing');
        }
        const releaseKey = ctx.releaseIdempotencyKey ?? deriveReleaseIdempotencyKey(ctx, plan);
        const ttlSeconds = resolveCapacityIdempotencyTtl(ctx);
        const { status } = await executeWithIdempotency({
          store: ctx.idempotencyStore,
          key: releaseKey,
          ttlSeconds,
          execute: async () => {
            await ctx.releaseExecutor!.apply(plan, meta);
            ctx.capacityWindow.heldSlots = plan.heldSlotsAfter;
            logger.info('capacity.micro_release.applied', {
              practiceId: ctx.practiceId,
              runId: ctx.id,
              slots: plan.slotsToRelease,
            });
            return true;
          },
          onDuplicate: () => {
            logger.warn('capacity.micro_release.duplicate', {
              practiceId: ctx.practiceId,
              runId: ctx.id,
              slots: plan.slotsToRelease,
              key: releaseKey,
            });
          },
          onError: (error) => {
            logger.error('capacity.micro_release.idempotency_failed', {
              practiceId: ctx.practiceId,
              runId: ctx.id,
              slots: plan.slotsToRelease,
              key: releaseKey,
              reason: error instanceof Error ? error.message : 'unknown_error',
            });
          },
        });
        if (status === 'skipped') {
          ctx.capacityWindow.heldSlots = plan.heldSlotsAfter;
        }
      }
    }

    const auditRecord = buildAuditRecord(ctx, plan, decision);
    if (ctx.auditor) {
      const auditKey = ctx.auditIdempotencyKey ?? deriveAuditIdempotencyKey(ctx);
      const ttlSeconds = resolveCapacityIdempotencyTtl(ctx);
      await executeWithIdempotency({
        store: ctx.idempotencyStore,
        key: auditKey,
        ttlSeconds,
        execute: async () => {
          await ctx.auditor!.record(auditRecord);
          logger.info('capacity.micro_release.audit_recorded', {
            practiceId: ctx.practiceId,
            runId: ctx.id,
            key: auditKey,
          });
          return true;
        },
        onDuplicate: () => {
          logger.warn('capacity.micro_release.audit_duplicate', {
            practiceId: ctx.practiceId,
            runId: ctx.id,
            key: auditKey,
          });
        },
        onError: (error) => {
          logger.error('capacity.micro_release.audit_failed', {
            practiceId: ctx.practiceId,
            runId: ctx.id,
            key: auditKey,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
        },
      });
    }

    return 'Applied';
  }
}

function resolveCapacitySettings(ctx: CapacityContext): CapacitySettings {
  const holdBackFraction = clampNumber(
    pickNumeric(ctx, ['hold_back_fraction', 'holdBackFraction']) ?? HOLD_BACK_DEFAULT,
    HOLD_BACK_MIN,
    HOLD_BACK_MAX,
  );

  const releaseMaxFraction = clampNumber(
    pickNumeric(ctx, ['release_max_fraction', 'releaseMaxFraction']) ?? Math.min(RELEASE_MAX_DEFAULT, holdBackFraction),
    0,
    holdBackFraction > 0 ? holdBackFraction : RELEASE_MAX_DEFAULT,
  );

  const minHoldFraction = clampNumber(
    pickNumeric(ctx, ['release_min_hold_fraction', 'minHoldFraction']) ?? Math.max(0, holdBackFraction - releaseMaxFraction),
    0,
    holdBackFraction,
  );

  const deltaThreshold = Math.max(
    0,
    pickNumeric(ctx, ['release_delta_threshold', 'deltaThreshold']) ?? DELTA_THRESHOLD_DEFAULT,
  );

  const confidenceThreshold = clampNumber(
    pickNumeric(ctx, ['release_confidence_threshold', 'confidenceThreshold']) ?? CONFIDENCE_THRESHOLD_DEFAULT,
    0.1,
    0.99,
  );

  const horizonMinutes = clampNumber(
    ctx.forecastHorizonMinutes ??
      pickNumeric(ctx, ['forecast_horizon_minutes', 'horizonMinutes']) ??
      120,
    MIN_FORECAST_MINUTES,
    MAX_FORECAST_MINUTES,
  );

  return {
    holdBackFraction,
    releaseMaxFraction,
    minHoldFraction,
    deltaThreshold,
    confidenceThreshold,
    horizonMinutes,
  };
}

function pickNumeric(ctx: CapacityContext, keys: string[]): number | undefined {
  const configRecord = ctx.config as Record<string, unknown>;
  for (const key of keys) {
    const value = parseMaybeNumber(configRecord[key]);
    if (value !== undefined) return value;
  }

  const capacity = configRecord.capacity;
  if (isRecord(capacity)) {
    for (const key of keys) {
      const value = parseMaybeNumber(capacity[key]);
      if (value !== undefined) return value;
    }
    const release = capacity.release;
    if (isRecord(release)) {
      for (const key of keys) {
        const value = parseMaybeNumber(release[key]);
        if (value !== undefined) return value;
      }
    }
  }

  return undefined;
}

function parseMaybeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function dedupeCaps(caps: ReleaseCap[]): ReleaseCap[] {
  return Array.from(new Set(caps));
}

function buildAuditRecord(
  ctx: CapacityContext,
  plan: ReleasePlan,
  decision: ReleaseDecision,
): CapacityAuditRecord {
  const forecast = ctx.forecast!;
  const now = (ctx.clock ? ctx.clock() : new Date()).toISOString();
  return {
    practiceId: ctx.practiceId,
    runId: ctx.id,
    timestamp: now,
    correlationId: ctx.correlationId,
    dryRun: Boolean(ctx.dryRun),
    outcome: decision.outcome,
    reason: decision.reason,
    release: {
      slots: plan.slotsToRelease,
      fraction: plan.releaseFraction,
      heldBefore: plan.heldSlotsBefore,
      heldAfter: plan.heldSlotsAfter,
      cappedBy: plan.cappedBy,
      maxFractionSlots: plan.maxFractionSlots,
      minReserveSlots: plan.minReserveSlots,
      deltaThreshold: decision.deltaThreshold,
      confidenceThreshold: decision.confidenceThreshold,
    },
    forecast: {
      delta: forecast.delta,
      confidence: forecast.confidence,
      lowerBound: forecast.band.lower,
      upperBound: forecast.band.upper,
      horizonMinutes: forecast.horizonMinutes,
      need: forecast.need,
      supply: forecast.supply,
    },
  };
}

function buildZeroReleasePlan(
  heldSlots: number,
  totalSlots: number,
  maxFractionSlots: number,
  minReserveSlots: number,
): ReleasePlan {
  return {
    slotsToRelease: 0,
    releaseFraction: 0,
    heldSlotsBefore: heldSlots,
    heldSlotsAfter: heldSlots,
    maxFractionSlots,
    minReserveSlots,
    cappedBy: [],
  };
}

function resolveCapacityIdempotencyTtl(ctx: CapacityContext): number {
  const ttl = ctx.idempotencyTtlSeconds;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CAPACITY_IDEMPOTENCY_TTL_SECONDS;
}

function deriveReleaseIdempotencyKey(ctx: CapacityContext, plan: ReleasePlan): string {
  const practice = ctx.practiceId ?? 'unknown-practice';
  return ctx.releaseIdempotencyKey ?? `capacity:release:${practice}:${ctx.id}:${plan.slotsToRelease}`;
}

function deriveAuditIdempotencyKey(ctx: CapacityContext): string {
  const practice = ctx.practiceId ?? 'unknown-practice';
  return ctx.auditIdempotencyKey ?? `capacity:audit:${practice}:${ctx.id}`;
}

async function evaluateTelemetryHealth(
  source: CapacityContext['telemetrySource'],
  clock?: () => Date,
): Promise<TelemetryHealth> {
  const nowIso = (clock ?? (() => new Date()))().toISOString();
  if (!source.health) {
    return { ok: true, checkedAt: nowIso };
  }
  try {
    const result = await source.health();
    if (!result) {
      return { ok: true, checkedAt: nowIso };
    }
    const ok = typeof result.ok === 'boolean' ? result.ok : true;
    return {
      ok,
      reason: result.reason,
      checkedAt: result.checkedAt ?? nowIso,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'telemetry_health_error';
    return { ok: false, reason, checkedAt: nowIso };
  }
}

function buildEmptyTelemetrySnapshot(collectedAt: string): TelemetrySnapshot {
  return {
    arrivalsPerHour: 0,
    queueDepth: 0,
    noShowRate: 0,
    staffingLevel: 0,
    collectedAt,
  };
}

function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return 'telemetry_collect_failed';
}

function defaultClock(): Date {
  return new Date();
}
const releaseDecidedCounter = createCounter('capacity.release.decided');
const releaseDurationHistogram = createHistogram('capacity.release.duration_ms');
