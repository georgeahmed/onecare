// Minimal scheduler placeholder for portal uptime guard and similar periodic tasks.
// Replace with a proper scheduler or job queue as needed.

import { randomUUID } from 'node:crypto';
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
} from './application/portal.state';
import type { DeferralStore, DeferralRecord } from '@onecare/ports';
import type { DeferralFlushContext } from './application/portal.state';

export type Task = () => Promise<void> | void;
export interface ScheduleOptions {
  jitterMs?: number;
  signal?: AbortSignal;
}

export interface ScheduledTask {
  cancel(): void;
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
}

export function startPortalUptimeGuard(practiceId: string, deps: PortalGuardDependencies): ScheduledTask {
  const nowFn = deps.now ?? (() => new Date());
  const correlationFactory = deps.correlationIdFactory ?? defaultCorrelationId;
  const ttl = deps.singleflightTtlMs ?? DEFAULT_SINGLEFLIGHT_TTL_MS;
  let inFlight = false;
  let lastStartedAt = 0;

  const tick = async () => {
    const now = nowFn();
    const startedAt = now.valueOf();
    if (inFlight) return;
    if (startedAt - lastStartedAt < ttl) return;
    inFlight = true;
    lastStartedAt = startedAt;
    const correlationId = correlationFactory();
    try {
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
    } catch (error) {
      logger.error('portal.guard.tick_failed', {
        practiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  const scheduled = everyWithJitter(60_000, 5_000, () => {
    void tick();
  });

  return {
    cancel: () => scheduled.cancel(),
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
  publish(record: DeferralRecord, context: DeferralPublishContext): Promise<void>;
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
