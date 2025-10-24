// Minimal scheduler placeholder for portal uptime guard and similar periodic tasks.
// Replace with a proper scheduler or job queue as needed.

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ResolvedConfig } from '@onecare/config';
import { createCounter, createGauge, createHistogram, logger, setCorrelationId, startSpan } from '@onecare/observability';
import {
  ensurePortalState,
  type CoreHours,
  type OohPolicy,
  type PortalDecision,
  type PortalDecisionReason,
  type PortalIntent,
  type PortalState,
  type DeferralFlushContext,
} from './application/portal.state';
import type { PortalNotifyPublishRequest, PortalNotifyPublisher } from './adapters/portal-notifier';
import type { DeferralStore, DeferralRecord } from '@onecare/ports';

export type Task = () => Promise<void> | void;
export interface ScheduleOptions {
  jitterMs?: number;
  signal?: AbortSignal;
}

export interface ScheduledTask {
  cancel(): void;
  __trigger?(): Promise<void>;
}

export interface PortalGuardStatus {
  ready: boolean;
  inflight: number;
  draining: boolean;
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
}

export interface PortalGuardHandle extends ScheduledTask {
  status(): PortalGuardStatus;
  drain(options?: { timeoutMs?: number }): Promise<'completed' | 'timeout'>;
}

export function every(intervalMs: number, task: Task): ScheduledTask {
  return everyWithJitter(intervalMs, 0, task);
}

export function everyWithJitter(intervalMs: number, jitterMs: number, task: Task, opts: ScheduleOptions = {}): ScheduledTask {
  let cancelled = false;
  const run = () => {
    if (cancelled || (opts.signal && (opts.signal as any).aborted)) return;
    Promise.resolve(task()).catch(() => {
      // swallow errors in skeleton; add logging when observability is ready
    }).finally(() => {
      if (cancelled || (opts.signal && (opts.signal as any).aborted)) return;
      const j = jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * jitterMs) : 0; // ±jitter
      const delay = Math.max(0, intervalMs + j);
      setTimeout(run, delay);
    });
  };
  // kick off initial run after a small jitter to avoid herd
  const initialDelay = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  const t = setTimeout(run, initialDelay);
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(t);
    }
  };
}

const portalTickCounter = createCounter('portal.tick');
const portalStateChangedCounter = createCounter('portal.state.changed');
const portalStateUnchangedCounter = createCounter('portal.state.unchanged');
const deferralFlushCounter = createCounter('deferral.flush.count');
const deferralExpiredCounter = createCounter('deferral.expired');
const schedulerTickCounter = createCounter('scheduler.tick');
const schedulerSkipCounter = createCounter('scheduler.skip.singleflight');
const schedulerNoopCounter = createCounter('scheduler.idempotent.noop');
const portalTickLatency = createHistogram('portal.tick.duration_ms');
const deferralProcessDuration = createHistogram('portal.deferral.process.duration_ms');
const schedulerInflightGauge = createGauge('inflight.ticks');

const DEFAULT_SINGLEFLIGHT_TTL_MS = 15_000;

export interface PortalIntentContext {
  practiceId: string;
  correlationId: string;
  desiredState: PortalState;
  reason: PortalDecisionReason;
  decision: PortalDecision;
}

export interface PortalAdapter {
  getState(): Promise<PortalState>;
  applyIntents(intents: PortalIntent[], context: PortalIntentContext): Promise<void>;
}

export interface PortalGuardDependencies {
  loadConfig(practiceId: string): Promise<ResolvedConfig>;
  adapter: PortalAdapter;
  now?: () => Date;
  singleflightTtlMs?: number;
  correlationIdFactory?: () => string;
  deferralStore?: DeferralStore;
  deferralPublisher?: DeferralPublisher;
  portalNotifyPublisher?: PortalNotifyPublisher;
  monotonicNow?: () => number;
}

const MAX_CONSECUTIVE_FAILURES_FOR_READINESS = 3;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

export function startPortalUptimeGuard(practiceId: string, deps: PortalGuardDependencies): PortalGuardHandle {
  const nowFn = deps.now ?? (() => new Date());
  const correlationFactory = deps.correlationIdFactory ?? defaultCorrelationId;
  const ttl = deps.singleflightTtlMs ?? DEFAULT_SINGLEFLIGHT_TTL_MS;
  const intervalMs = 60_000;
  const jitterMs = 5_000;
  let lastRunCompletedAtMonotonic = 0;
  let timer: NodeJS.Timeout | undefined;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const state: PortalGuardStatus & { lastSuccessAt?: number; lastErrorAt?: number } = {
    ready: false,
    inflight: 0,
    draining: false,
    consecutiveFailures: 0,
    lastSuccessAt: undefined,
    lastErrorAt: undefined,
  };
  let draining = false;
  let drainWaiter: (() => void) | undefined;
  let drainTimeout: NodeJS.Timeout | undefined;

  const updateGauge = () => {
    schedulerInflightGauge.set(state.inflight, { practiceId });
  };

  const notifyDrainIfIdle = () => {
    if (state.inflight === 0 && drainWaiter) {
      const callback = drainWaiter;
      drainWaiter = undefined;
      if (drainTimeout) {
        clearTimeout(drainTimeout);
        drainTimeout = undefined;
      }
      callback();
    }
  };

  const schedule = (baseDelay: number, opts: { applyJitter?: boolean } = {}): void => {
    if (draining) {
      return;
    }
    const applyJitter = opts.applyJitter ?? true;
    const jitter = applyJitter && jitterMs > 0
      ? Math.floor((Math.random() * 2 - 1) * jitterMs)
      : 0;
    const delay = Math.max(0, baseDelay + jitter);
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    if (draining) {
      return;
    }

    if (state.inflight > 0) {
      schedulerSkipCounter.add(1, { practiceId, reason: 'in_flight' });
      schedule(intervalMs);
      return;
    }

    const now = nowFn();
    const correlationId = correlationFactory();
    setCorrelationId(correlationId);
    const span = startSpan('portal.tick');
    if (span.isRecording()) {
      span.setAttribute('portal.practice_id', practiceId);
    }
    const startedAt = monotonicNow();
    const nowMonotonic = monotonicNow();
    if (lastRunCompletedAtMonotonic > 0) {
      const elapsed = nowMonotonic - lastRunCompletedAtMonotonic;
      if (elapsed < ttl) {
        schedulerSkipCounter.add(1, { practiceId, reason: 'lease_active' });
        span.end();
        setCorrelationId(undefined);
        schedule(ttl - elapsed, { applyJitter: false });
        return;
      }
    }

    state.inflight += 1;
    state.draining = draining;
    updateGauge();
    let ran = false;
    try {
      schedulerTickCounter.add(1, { practiceId });
      portalTickCounter.add(1, { practiceId });
      const config = await deps.loadConfig(practiceId);
      const decision = await runPortalGuardTick(practiceId, now, correlationId, config, deps.adapter, deps);
      const attributes = {
        practiceId,
        reason: decision.reason,
        state: decision.desiredState.portalOpen ? 'open' : 'closed',
      };
      if (decision.changed) {
        portalStateChangedCounter.add(1, attributes);
      } else {
        portalStateUnchangedCounter.add(1, attributes);
      }
      ran = true;
      state.ready = true;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = monotonicNow();
    } catch (error) {
      state.consecutiveFailures += 1;
      state.lastErrorAt = monotonicNow();
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_FOR_READINESS) {
        state.ready = false;
      }
      logger.error('portal.guard.tick_failed', {
        component: 'access-gate',
        practiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (ran) {
        lastRunCompletedAtMonotonic = monotonicNow();
      }
      portalTickLatency.record(monotonicNow() - startedAt, { practiceId, ran: String(ran) });
      span.end();
      setCorrelationId(undefined);
      state.inflight = Math.max(0, state.inflight - 1);
      state.draining = draining;
      updateGauge();
      if (!draining) {
        schedule(intervalMs);
      }
      notifyDrainIfIdle();
    }
  };

  schedule(0, { applyJitter: false });
  updateGauge();

  const drain = async (options?: { timeoutMs?: number }): Promise<'completed' | 'timeout'> => {
    draining = true;
    state.draining = true;
    state.ready = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (state.inflight === 0) {
      updateGauge();
      return 'completed';
    }
    const timeoutMs = Math.max(0, options?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    return await new Promise<'completed' | 'timeout'>((resolve) => {
      let settled = false;
      const finish = (result: 'completed' | 'timeout') => {
        if (settled) return;
        settled = true;
        if (drainTimeout) {
          clearTimeout(drainTimeout);
          drainTimeout = undefined;
        }
        drainWaiter = undefined;
        resolve(result);
      };
      drainWaiter = () => finish('completed');
      drainTimeout = setTimeout(() => finish('timeout'), timeoutMs);
    });
  };

  return {
    cancel: () => {
      draining = true;
      state.draining = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    __trigger: tick,
    status: () => ({
      ready: state.ready,
      inflight: state.inflight,
      draining: state.draining,
      consecutiveFailures: state.consecutiveFailures,
      lastSuccessAt: state.lastSuccessAt,
      lastErrorAt: state.lastErrorAt,
    }),
    drain,
  };
}

export async function runPortalGuardTick(
  practiceId: string,
  now: Date,
  correlationId: string,
  config: ResolvedConfig,
  adapter: PortalAdapter,
  deps: PortalGuardDependencies,
): Promise<PortalDecision> {
  const timeZone = typeof (config as Record<string, unknown>).timezone === 'string'
    ? ((config as Record<string, unknown>).timezone as string)
    : undefined;

  const currentState = await adapter.getState();
  const decision = ensurePortalState({
    now,
    timeZone,
    coreHours: config.core_hours as CoreHours | undefined,
    policy: (config as Record<string, unknown>).ooh_policy as OohPolicy | undefined,
    currentState,
  });

  logDecision(practiceId, correlationId, decision);

  if (!decision.changed || decision.intents.length === 0) {
    schedulerNoopCounter.add(1, { practiceId, reason: 'unchanged' });
    await processDeferrals(practiceId, now, correlationId, decision, deps);
    return decision;
  }

  await adapter.applyIntents(decision.intents, {
    practiceId,
    correlationId,
    desiredState: decision.desiredState,
    reason: decision.reason,
    decision,
  });

  if (deps.portalNotifyPublisher) {
    const notifyRequest = buildPortalNotifyRequest(practiceId, correlationId, now, decision);
    try {
      await deps.portalNotifyPublisher.publish(notifyRequest);
    } catch (error) {
      logger.error('portal.notify.publish_unhandled_failure', {
        practiceId,
        correlationId,
        state: notifyRequest.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await processDeferrals(practiceId, now, correlationId, decision, deps);
  return decision;
}

function logDecision(practiceId: string, correlationId: string, decision: PortalDecision): void {
  const base = {
    practiceId,
    correlationId,
    reason: decision.reason,
    changed: decision.changed,
    state: decision.desiredState.portalOpen ? 'open' : 'closed',
    acceptsSubmissions: decision.desiredState.acceptsSubmissions,
    banner: decision.desiredState.bannerMessage,
    localIsoDate: decision.localDateTime.isoDate,
    minutesOfDay: decision.localDateTime.minutesOfDay,
  };

  if (decision.reason === 'config_missing' || decision.reason === 'config_invalid') {
    logger.warn('portal.guard.config_issue', base);
    return;
  }

  if (decision.changed) {
    logger.info('portal.guard.state_changed', base);
  } else {
    logger.debug('portal.guard.state_unchanged', base);
  }
}

function defaultCorrelationId(): string {
  try {
    return randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

export interface DeferralPublisher {
  publish(record: DeferralRecord, context: DeferralFlushContext): Promise<void>;
}

export async function processDeferrals(
  practiceId: string,
  now: Date,
  correlationId: string,
  decision: PortalDecision,
  deps: PortalGuardDependencies,
): Promise<void> {
  const store = deps.deferralStore;
  if (!store) return;

  const span = startSpan('portal.deferral.process');
  if (span.isRecording()) {
    span.setAttribute('portal.practice_id', practiceId);
    span.setAttribute('portal.correlation_id', correlationId);
  }
  const startedAt = performance.now();

  const nowIso = now.toISOString();
  try {
    const expired = await store.expireStale(nowIso);
    if (expired > 0) {
      deferralExpiredCounter.add(expired, { practiceId });
    }
  } catch (error) {
    logger.warn('portal.deferral.expire_failed', {
      practiceId,
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (decision.reason !== 'within_hours') {
    deferralProcessDuration.record(performance.now() - startedAt, { practiceId, reason: decision.reason });
    span.end();
    return;
  }

  try {
    const flush = await store.flushReady(practiceId, nowIso);
    if (flush.records.length === 0) return;

    deferralFlushCounter.add(flush.records.length, { practiceId });
    logger.info('portal.deferral.flushed', {
      component: 'access-gate',
      practiceId,
      correlationId,
      count: flush.records.length,
    });

    if (deps.deferralPublisher) {
      const context: DeferralFlushContext = {
        practiceId,
        correlationId,
        records: flush.records,
      };
      for (const record of flush.records) {
        await deps.deferralPublisher.publish(record, context);
      }
    }
  } catch (error) {
    logger.error('portal.deferral.flush_failed', {
      practiceId,
      correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    deferralProcessDuration.record(performance.now() - startedAt, { practiceId, reason: decision.reason });
    span.end();
  }
}

function buildPortalNotifyRequest(
  practiceId: string,
  correlationId: string,
  now: Date,
  decision: PortalDecision,
): PortalNotifyPublishRequest {
  const request: PortalNotifyPublishRequest = {
    practiceId,
    state: derivePortalState(decision),
    at: now.toISOString(),
    correlationId,
  };
  const reasonCode = deriveReasonCode(decision.reason);
  if (reasonCode) {
    request.reasonCode = reasonCode;
  }
  return request;
}

function derivePortalState(decision: PortalDecision): 'UP' | 'DOWN' | 'OOH' {
  if (decision.reason === 'outside_hours') {
    return 'OOH';
  }
  return decision.desiredState.portalOpen ? 'UP' : 'DOWN';
}

function deriveReasonCode(reason: PortalDecisionReason): string | undefined {
  switch (reason) {
    case 'within_hours':
    case 'outside_hours':
      return 'CORE_HOURS';
    case 'config_missing':
      return 'CONFIG_MISSING';
    case 'config_invalid':
      return 'CONFIG_INVALID';
    default:
      return undefined;
  }
}
