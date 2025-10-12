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

const BASE_CONFIG = {
  practiceId: 'demo',
  timezone: 'Europe/London',
  core_hours: { start: '08:00', end: '18:00' },
  ooh_policy: {
    accept_submissions: false,
    patient_message: 'Portal closed. Contact NHS 111.',
  },
} as unknown as ResolvedConfig;

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
    });

    await vi.runOnlyPendingTimersAsync();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(adapter.applyIntents).toHaveBeenCalledTimes(1);
    expect(adapter.state.portalOpen).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadConfig).toHaveBeenCalledTimes(2);
    guard.cancel();

    const tickRecords = getCounterRecords('portal.tick');
    expect(tickRecords.length).toBeGreaterThanOrEqual(2);
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
  });
});

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
