import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import {
  getGaugeRecords,
  getGaugeValue,
  resetMetrics,
} from '@onecare/observability';
import {
  startPortalUptimeGuard,
  type PortalAdapter,
} from '../src/scheduler';

const BASE_CONFIG = {
  practiceId: 'demo',
  timezone: 'Europe/London',
  core_hours: { start: '08:00', end: '18:00' },
} as unknown as ResolvedConfig;

function createMonotonicSequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

describe('portal uptime guard shutdown', () => {
  const originalRandom = Math.random;

  beforeEach(() => {
    resetMetrics();
    Math.random = vi.fn(() => 0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    Math.random = originalRandom;
    vi.useRealTimers();
  });

  it('waits for in-flight tick to finish before resolving drain', async () => {
    let resolveConfig: (() => void) | undefined;
    const loadConfig = vi.fn(
      () =>
        new Promise<ResolvedConfig>((resolve) => {
          resolveConfig = () => resolve(BASE_CONFIG);
        }),
    );
    const adapter: PortalAdapter = {
      getState: async () => ({ portalOpen: false, acceptsSubmissions: false }),
      applyIntents: async () => {},
    };

    const guard = startPortalUptimeGuard('practice-drain', {
      loadConfig,
      adapter,
      now: () => new Date('2025-01-01T08:00:00Z'),
      monotonicNow: createMonotonicSequence([0, 1_000, 2_000, 3_000]),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(loadConfig).toHaveBeenCalledTimes(1);

    const drainPromise = guard.drain({ timeoutMs: 5_000 });
    await Promise.resolve();
    expect(getGaugeValue('inflight.ticks')).toBe(1);

    resolveConfig?.();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    const result = await drainPromise;
    expect(result).toBe('completed');
    expect(getGaugeValue('inflight.ticks')).toBe(0);
    const records = getGaugeRecords('inflight.ticks');
    expect(records.some((entry) => entry.value === 1)).toBe(true);
    expect(records[records.length - 1]?.value).toBe(0);

    guard.cancel();
  });

  it('times out drain when tick does not finish', async () => {
    const loadConfig = vi.fn(
      () =>
        new Promise<ResolvedConfig>(() => {
          // never resolve
        }),
    );
    const adapter: PortalAdapter = {
      getState: async () => ({ portalOpen: false, acceptsSubmissions: false }),
      applyIntents: async () => {},
    };

    const guard = startPortalUptimeGuard('practice-timeout', {
      loadConfig,
      adapter,
      now: () => new Date('2025-01-01T08:00:00Z'),
      monotonicNow: createMonotonicSequence([0, 1_000, 2_000]),
    });

    await vi.runOnlyPendingTimersAsync();
    const drainPromise = guard.drain({ timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await drainPromise;
    expect(outcome).toBe('timeout');
    expect(getGaugeValue('inflight.ticks')).toBe(1);
    guard.cancel();
  });
});
