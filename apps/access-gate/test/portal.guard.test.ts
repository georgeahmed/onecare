import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ensurePortalState,
  enqueueOutOfHoursSubmission,
  type PortalState,
  type PortalIntent,
} from '../src/application/portal.state';
import {
  startPortalUptimeGuard,
  type PortalAdapter,
  type PortalIntentContext,
} from '../src/scheduler';
import { getCounterRecords, resetMetrics } from '@onecare/observability';
import type { ResolvedConfig } from '@onecare/config';
import type { DeferralStore, DeferralRecord } from '@onecare/ports';
import type { DeferralPublisher } from '../src/scheduler';
import type { PortalNotifyPublishRequest, PortalNotifyPublisher } from '../src/adapters/portal-notifier';

class MemoryPortalAdapter implements PortalAdapter {
  public state: PortalState = {
    portalOpen: false,
    acceptsSubmissions: false,
  };

  public getState = vi.fn(async () => ({ ...this.state }));

  public applyIntents = vi.fn(async (intents: PortalIntent[], context: PortalIntentContext) => {
    for (const intent of intents) {
      switch (intent.type) {
        case 'OPEN_PORTAL':
          this.state.portalOpen = true;
          break;
        case 'CLOSE_PORTAL':
          this.state.portalOpen = false;
          break;
        case 'SET_SUBMISSION_MODE':
          this.state.acceptsSubmissions = intent.acceptsSubmissions;
          break;
        case 'SET_BANNER':
          this.state.bannerMessage = intent.message;
          break;
        case 'CLEAR_BANNER':
          delete this.state.bannerMessage;
          break;
        default:
          break;
      }
    }
    // Apply final desired state to keep adapter idempotent.
    this.state = { ...context.desiredState };
  });
}

class MemoryDeferralStore implements DeferralStore {
  private readonly items = new Map<string, { record: DeferralRecord; expiresAt: number }>();

  constructor(private readonly nowFn: () => number = Date.now) {}

  async enqueue(record: DeferralRecord, ttlMs: number) {
    const expiresAt = this.nowFn() + ttlMs;
    this.items.set(record.id, { record, expiresAt });
    return { record, expiresAt: new Date(expiresAt).toISOString() };
  }

  async flushReady(practiceId: string, untilIsoTs: string) {
    const cutoff = Date.parse(untilIsoTs);
    const records: DeferralRecord[] = [];
    for (const [key, value] of this.items) {
      if (value.record.practiceId !== practiceId) continue;
      const deferUntil = Date.parse(value.record.deferUntil);
      if (!Number.isFinite(deferUntil) || deferUntil > cutoff) continue;
      records.push(value.record);
      this.items.delete(key);
    }
    return { records, deletedCount: records.length };
  }

  async expireStale(nowIsoTs: string) {
    const now = Date.parse(nowIsoTs);
    let removed = 0;
    for (const [key, value] of this.items) {
      if (value.expiresAt <= now) {
        this.items.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

class FakeDeferralPublisher implements DeferralPublisher {
  public published: DeferralRecord[] = [];

  async publish(record: DeferralRecord, _context: DeferralFlushContext): Promise<void> {
    this.published.push(record);
  }
}

class MockPortalNotifier implements PortalNotifyPublisher {
  public readonly requests: PortalNotifyPublishRequest[] = [];

  public publish = vi.fn(async (request: PortalNotifyPublishRequest) => {
    this.requests.push(request);
  });
}

const BASE_CONFIG = {
  practiceId: 'demo',
  timezone: 'Europe/London',
  core_hours: { start: '08:00', end: '18:00' },
  ooh_policy: {
    accept_submissions: false,
    patient_message: 'Portal closed. Contact NHS 111.',
  },
} as unknown as ResolvedConfig;

function createMonotonicStepper(stepMs: number): () => number {
  let current = 0;
  return () => {
    current += stepMs;
    return current;
  };
}

function createMonotonicSequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

describe('ensurePortalState', () => {
  it('opens portal within configured hours', () => {
    const decision = ensurePortalState({
      now: new Date('2025-01-01T09:00:00Z'),
      timeZone: 'Europe/London',
      coreHours: { start: '08:00', end: '18:00' },
      policy: { accept_submissions: false, patient_message: 'Closed' },
      currentState: { portalOpen: false, acceptsSubmissions: false },
    });

    expect(decision.reason).toBe('within_hours');
    expect(decision.changed).toBe(true);
    expect(decision.desiredState.portalOpen).toBe(true);
    expect(decision.desiredState.acceptsSubmissions).toBe(true);
    expect(decision.desiredState.bannerMessage).toBeUndefined();
  });

  it('enforces out-of-hours policy with banner', () => {
    const decision = ensurePortalState({
      now: new Date('2025-01-01T21:00:00Z'),
      timeZone: 'Europe/London',
      coreHours: { start: '08:00', end: '18:00' },
      policy: { accept_submissions: false, patient_message: 'Closed now' },
      currentState: { portalOpen: true, acceptsSubmissions: true },
    });

    expect(decision.reason).toBe('outside_hours');
    expect(decision.changed).toBe(true);
    expect(decision.desiredState.portalOpen).toBe(false);
    expect(decision.desiredState.acceptsSubmissions).toBe(false);
    expect(decision.desiredState.bannerMessage).toBe('Closed now');
  });

  it('handles DST transitions without double toggles', () => {
    const beforeDst = ensurePortalState({
      now: new Date('2025-03-30T06:59:00Z'),
      timeZone: 'Europe/London',
      coreHours: { start: '08:00', end: '18:00' },
      currentState: { portalOpen: false, acceptsSubmissions: false },
    });
    expect(beforeDst.reason).toBe('outside_hours');

    const afterDst = ensurePortalState({
      now: new Date('2025-03-30T07:00:00Z'),
      timeZone: 'Europe/London',
      coreHours: { start: '08:00', end: '18:00' },
      currentState: { portalOpen: false, acceptsSubmissions: false },
    });
    expect(afterDst.reason).toBe('within_hours');
  });

  it('returns config_missing when core hours absent', () => {
    const decision = ensurePortalState({
      now: new Date(),
      timeZone: 'Europe/London',
    });
    expect(decision.reason).toBe('config_missing');
    expect(decision.changed).toBe(false);
    expect(decision.intents).toHaveLength(0);
  });
});

describe('deferral queue helpers', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('enqueues submission when outside hours and deferral enabled', async () => {
    const config = {
      ...BASE_CONFIG,
      ooh_policy: { accept_submissions: true, patient_message: 'We will respond soon' },
    } as ResolvedConfig;
    const store = new MemoryDeferralStore(() => Date.parse('2025-01-01T20:00:00Z'));
    const outcome = await enqueueOutOfHoursSubmission({
      practiceId: 'practice-1',
      submissionId: 'sub-1',
      summaryCode: 'summary',
      receivedAt: new Date('2025-01-01T20:00:00Z'),
      config,
      store,
      correlationId: 'corr-enqueue',
    });
    expect(outcome.enqueued).toBe(true);
    expect(outcome.record?.deferUntil).toBeDefined();
    const enqueueRecords = getCounterRecords('deferral.enqueue');
    expect(enqueueRecords[0].attributes?.practiceId).toBe('practice-1');
  });

  it('skips enqueue when within core hours', async () => {
    const config = {
      ...BASE_CONFIG,
      ooh_policy: { accept_submissions: true, patient_message: 'We will respond soon' },
    } as ResolvedConfig;
    const store = new MemoryDeferralStore(() => Date.parse('2025-01-01T09:00:00Z'));
    const outcome = await enqueueOutOfHoursSubmission({
      practiceId: 'practice-1',
      submissionId: 'sub-2',
      summaryCode: 'summary',
      receivedAt: new Date('2025-01-01T09:00:00Z'),
      config,
      store,
    });
    expect(outcome.enqueued).toBe(false);
    expect(getCounterRecords('deferral.enqueue')).toHaveLength(0);
  });
});

describe('portal uptime guard scheduler', () => {
  const originalRandom = Math.random;
  let adapter: MemoryPortalAdapter;

  beforeEach(() => {
    resetMetrics();
    adapter = new MemoryPortalAdapter();
  });

  afterEach(() => {
    Math.random = originalRandom;
    vi.useRealTimers();
  });

  it('applies intents and records metrics on tick', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    const loadConfig = vi.fn(async () => BASE_CONFIG);
    const notifier = new MockPortalNotifier();
    const nowValues = [
      new Date('2025-01-01T08:30:00Z'),
      new Date('2025-01-01T08:31:10Z'),
    ];
    let index = 0;
    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => nowValues[Math.min(index++, nowValues.length - 1)],
      correlationIdFactory: () => 'corr-1',
      singleflightTtlMs: 5_000,
      portalNotifyPublisher: notifier,
      monotonicNow: createMonotonicStepper(60_000),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(adapter.applyIntents).toHaveBeenCalledTimes(1);
    expect(adapter.state.portalOpen).toBe(true);
    expect(notifier.publish).toHaveBeenCalledTimes(1);
    expect(notifier.requests[0]).toMatchObject({
      practiceId: 'practice-1',
      state: 'UP',
      correlationId: 'corr-1',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadConfig).toHaveBeenCalledTimes(2);
    guard.cancel();

    const tickRecords = getCounterRecords('portal.tick');
    expect(tickRecords.length).toBeGreaterThanOrEqual(2);
    const schedulerTickRecords = getCounterRecords('scheduler.tick');
    expect(schedulerTickRecords.length).toBeGreaterThanOrEqual(2);
  });

  it('skips duplicate work within TTL', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    const loadConfig = vi.fn(async () => BASE_CONFIG);
    const times = [
      new Date('2025-01-01T08:30:00Z'),
      new Date('2025-01-01T08:30:05Z'),
      new Date('2025-01-01T08:31:10Z'),
      new Date('2025-01-01T08:32:40Z'),
    ];
    let i = 0;

    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => times[Math.min(i++, times.length - 1)],
      singleflightTtlMs: 120_000,
      correlationIdFactory: () => 'corr-ttl',
      monotonicNow: createMonotonicSequence([0, 5_000, 10_000, 130_000, 250_000]),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(adapter.applyIntents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(adapter.applyIntents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(loadConfig).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(loadConfig).toHaveBeenCalledTimes(2);
    guard.cancel();
    const skipRecords = getCounterRecords('scheduler.skip.singleflight');
    expect(skipRecords.find((entry) => entry.attributes?.reason === 'lease_active')).toBeDefined();
    const schedulerTickRecords = getCounterRecords('scheduler.tick');
    expect(schedulerTickRecords.length).toBe(2);
  });

  it('does not publish portal notify when state unchanged', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    adapter.state = {
      portalOpen: true,
      acceptsSubmissions: true,
    };

    const loadConfig = vi.fn(async () => BASE_CONFIG);
    const notifier = new MockPortalNotifier();

    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => new Date('2025-01-01T08:30:00Z'),
      correlationIdFactory: () => 'corr-unchanged',
      singleflightTtlMs: 5_000,
      portalNotifyPublisher: notifier,
      monotonicNow: createMonotonicStepper(60_000),
    });

    await vi.runOnlyPendingTimersAsync();
    guard.cancel();

    expect(adapter.applyIntents).not.toHaveBeenCalled();
    expect(notifier.publish).not.toHaveBeenCalled();
    const noopRecords = getCounterRecords('scheduler.idempotent.noop');
    expect(noopRecords).toHaveLength(1);
    expect(noopRecords[0].attributes?.practiceId).toBe('practice-1');
  });

  it('collapses concurrent ticks via singleflight lease', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    let resolveConfig: (() => void) | undefined;
    const loadConfig = vi.fn(
      () =>
        new Promise<ResolvedConfig>((resolve) => {
          resolveConfig = () => resolve(BASE_CONFIG);
        }),
    );

    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => new Date('2025-01-01T08:30:00Z'),
      singleflightTtlMs: 5_000,
      correlationIdFactory: () => 'corr-singleflight',
      monotonicNow: createMonotonicStepper(60_000),
    });

    await vi.runOnlyPendingTimersAsync();
    const trigger = (guard as unknown as { __trigger: () => Promise<void> }).__trigger;
    await trigger();

    const skipRecords = getCounterRecords('scheduler.skip.singleflight');
    expect(skipRecords.find((entry) => entry.attributes?.reason === 'in_flight')).toBeDefined();

    resolveConfig?.();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    guard.cancel();
  });

  it('tolerates wall clock skew using monotonic timers', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    const loadConfig = vi.fn(async () => BASE_CONFIG);
    const nowValues = [
      new Date('2025-01-01T08:30:00Z'),
      new Date('2025-01-01T08:29:30Z'),
      new Date('2025-01-01T08:45:00Z'),
    ];
    let index = 0;

    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => nowValues[Math.min(index++, nowValues.length - 1)],
      singleflightTtlMs: 120_000,
      correlationIdFactory: () => 'corr-skew',
      monotonicNow: createMonotonicSequence([0, 5_000, 10_000, 130_000, 250_000]),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(loadConfig).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();

    expect(loadConfig).toHaveBeenCalledTimes(2);
    guard.cancel();

    const schedulerTickRecords = getCounterRecords('scheduler.tick');
    expect(schedulerTickRecords.length).toBe(2);
  });

  it('flushes deferrals when entering core hours', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    const config = {
      ...BASE_CONFIG,
      ooh_policy: { accept_submissions: true, patient_message: 'We will respond soon' },
    } as ResolvedConfig;
    const store = new MemoryDeferralStore(() => Date.parse('2025-01-01T20:00:00Z'));
    await enqueueOutOfHoursSubmission({
      practiceId: 'practice-1',
      submissionId: 'sub-flush',
      summaryCode: 'symptom',
      receivedAt: new Date('2025-01-01T20:00:00Z'),
      config,
      store,
      correlationId: 'corr-enqueue',
    });

    const publisher = new FakeDeferralPublisher();
    const loadConfig = vi.fn(async () => config);
    const times = [
      new Date('2025-01-01T20:00:00Z'),
      new Date('2025-01-02T08:01:00Z'),
    ];
    let i = 0;

    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => times[Math.min(i++, times.length - 1)],
      deferralStore: store,
      deferralPublisher: publisher,
      correlationIdFactory: () => 'corr-flush',
      singleflightTtlMs: 5_000,
      monotonicNow: createMonotonicStepper(60_000),
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    guard.cancel();

    expect(publisher.published).toHaveLength(1);
    const flushMetrics = getCounterRecords('deferral.flush.count');
    expect(flushMetrics[0].attributes?.practiceId).toBe('practice-1');
  });

  it('records expired deferrals', async () => {
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();

    const store = new MemoryDeferralStore(() => Date.parse('2025-01-01T21:00:00Z'));
    const record: DeferralRecord = {
      id: 'practice-1:sub-expire',
      practiceId: 'practice-1',
      submissionId: 'sub-expire',
      createdAt: '2025-01-01T20:00:00Z',
      summaryCode: 'symptom',
      deferUntil: '2025-01-02T08:00:00Z',
    };
    await store.enqueue(record, 1_000); // expire quickly

    const loadConfig = vi.fn(async () => BASE_CONFIG);
    const guard = startPortalUptimeGuard('practice-1', {
      loadConfig,
      adapter,
      now: () => new Date('2025-01-01T21:02:00Z'),
      deferralStore: store,
      correlationIdFactory: () => 'corr-expire',
      singleflightTtlMs: 5_000,
      monotonicNow: createMonotonicStepper(60_000),
    });

    await vi.runOnlyPendingTimersAsync();
    guard.cancel();

    const expiredMetrics = getCounterRecords('deferral.expired');
    expect(expiredMetrics[0].value).toBe(1);
  });
});
