import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ensurePortalState, type PortalDecision } from '../src/application/portal.state';
import {
  processDeferrals,
  type PortalGuardDependencies,
  type DeferralPublisher,
} from '../src/scheduler';
import type { DeferralRecord, DeferralStore } from '@onecare/ports';
import type { ResolvedConfig } from '@onecare/config';

class MemoryDeferralStore implements DeferralStore {
  private readonly items = new Map<string, { record: DeferralRecord; expiresAt: number }>();

  constructor(records: DeferralRecord[] = []) {
    for (const record of records) {
      this.items.set(record.id, { record, expiresAt: Number.POSITIVE_INFINITY });
    }
  }

  async enqueue(record: DeferralRecord, ttlMs: number) {
    const expiresAt = Date.parse(record.deferUntil) + ttlMs;
    this.items.set(record.id, { record, expiresAt });
    return {
      record,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async flushReady(practiceId: string, untilIsoTs: string) {
    const cutoff = Date.parse(untilIsoTs);
    const ready: DeferralRecord[] = [];
    for (const [key, value] of this.items) {
      if (value.record.practiceId !== practiceId) continue;
      const deferUntil = Date.parse(value.record.deferUntil);
      if (!Number.isFinite(deferUntil) || deferUntil > cutoff) continue;
      ready.push(value.record);
      this.items.delete(key);
    }
    return {
      records: ready,
      deletedCount: ready.length,
    };
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

class NullDeferralPublisher implements DeferralPublisher {
  public published = 0;

  async publish(): Promise<void> {
    this.published += 1;
  }
}

describe('access-gate performance baselines', () => {
  it('ensurePortalState executes within budget', () => {
    const iterations = 5000;
    const decisionInputs = {
      now: new Date('2025-01-02T09:00:00Z'),
      timeZone: 'Europe/London',
      coreHours: { start: '08:00', end: '18:00' },
      policy: { accept_submissions: false, patient_message: 'Closed' },
      currentState: { portalOpen: false, acceptsSubmissions: false },
    };

    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      ensurePortalState(decisionInputs);
    }
    const perRunMs = (performance.now() - start) / iterations;
    expect(perRunMs).toBeLessThan(0.05); // 50 µs budget
  });

  it('processDeferrals flushes at least 200 records per second in-memory', async () => {
    const records = Array.from({ length: 500 }, (_value, index) => {
      const base = Date.parse('2025-01-02T09:00:00.000Z');
      const deferUntil = new Date(base - 60_000 + index).toISOString();
      return {
        id: `practice-1:submission-${index}`,
        practiceId: 'practice-1',
        submissionId: `submission-${index}`,
        createdAt: new Date(2025, 0, 1, 20, 0, 0, index % 50).toISOString(),
        summaryCode: 'follow_up',
        deferUntil,
      } satisfies DeferralRecord;
    });

    const store = new MemoryDeferralStore(records);
    const publisher = new NullDeferralPublisher();
    const deps: PortalGuardDependencies = {
      loadConfig: async () =>
        ({
          practiceId: 'practice-1',
          core_hours: { start: '08:00', end: '18:00' },
        }) as unknown as ResolvedConfig,
      adapter: {
        getState: async () => ({ portalOpen: true, acceptsSubmissions: true }),
        applyIntents: async () => {},
      },
      deferralStore: store,
      deferralPublisher: publisher,
    };
    const decision: PortalDecision = {
      reason: 'within_hours',
      desiredState: { portalOpen: true, acceptsSubmissions: true },
      intents: [],
      changed: false,
      localDateTime: { isoDate: '2025-01-02', minutesOfDay: 540 },
    };

    const now = new Date('2025-01-02T09:00:00Z');
    const start = performance.now();
    await processDeferrals('practice-1', now, 'corr-perf', decision, deps);
    const elapsedSeconds = (performance.now() - start) / 1000;
    const throughput = records.length / Math.max(elapsedSeconds, Number.EPSILON);

    expect(throughput).toBeGreaterThanOrEqual(200);
    expect(publisher.published).toBe(records.length);
  });
});
