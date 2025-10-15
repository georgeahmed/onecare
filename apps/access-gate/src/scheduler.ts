// Minimal scheduler placeholder for portal uptime guard and similar periodic tasks.
// Replace with a proper scheduler or job queue as needed.

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ResolvedConfig } from '@onecare/config';
import { createCounter, logger } from '@onecare/observability';
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

export function startPortalUptimeGuard(practiceId: string, deps: PortalGuardDependencies): ScheduledTask {
  const nowFn = deps.now ?? (() => new Date());
  const correlationFactory = deps.correlationIdFactory ?? defaultCorrelationId;
  const ttl = deps.singleflightTtlMs ?? DEFAULT_SINGLEFLIGHT_TTL_MS;
  const intervalMs = 60_000;
  const jitterMs = 5_000;
  let inFlight = false;
  let lastRunCompletedAtMonotonic = 0;
  let timer: NodeJS.Timeout | undefined;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());

  const schedule = (baseDelay: number, opts: { applyJitter?: boolean } = {}): void => {
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
    if (inFlight) {
      schedulerSkipCounter.add(1, { practiceId, reason: 'in_flight' });
      schedule(intervalMs);
      return;
    }

    const now = nowFn();
    const nowMonotonic = monotonicNow();
    if (lastRunCompletedAtMonotonic > 0) {
      const elapsed = nowMonotonic - lastRunCompletedAtMonotonic;
      if (elapsed < ttl) {
        schedulerSkipCounter.add(1, { practiceId, reason: 'lease_active' });
        schedule(ttl - elapsed, { applyJitter: false });
        return;
      }
    }

    inFlight = true;
    let ran = false;
    const correlationId = correlationFactory();
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
    } catch (error) {
      logger.error('portal.guard.tick_failed', {
        practiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (ran) {
        lastRunCompletedAtMonotonic = monotonicNow();
      }
      inFlight = false;
      schedule(intervalMs);
    }
  };

  schedule(0, { applyJitter: false });

  return {
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    __trigger: tick,
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

async function processDeferrals(
  practiceId: string,
  now: Date,
  correlationId: string,
  decision: PortalDecision,
  deps: PortalGuardDependencies,
): Promise<void> {
  const store = deps.deferralStore;
  if (!store) return;

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

  if (decision.reason !== 'within_hours') return;

  try {
    const flush = await store.flushReady(practiceId, nowIso);
    if (flush.records.length === 0) return;

    deferralFlushCounter.add(flush.records.length, { practiceId });
    logger.info('portal.deferral.flushed', {
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
