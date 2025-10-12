import { describe, it, expect } from 'vitest';
import type { DeferralRecord, DeferralStore } from '../src/deferrals';

class MemoryDeferralStore implements DeferralStore {
  private readonly items = new Map<string, DeferralRecord & { expiresAt: number }>();

  constructor(private readonly nowFn: () => number = Date.now) {}

  async enqueue(record: DeferralRecord, ttlMs: number) {
    const expiresAt = this.nowFn() + ttlMs;
    this.items.set(record.id, { ...record, expiresAt });
    return { record, expiresAt: new Date(expiresAt).toISOString() };
  }

  async flushReady(practiceId: string, untilIsoTs: string) {
    const cutoff = Date.parse(untilIsoTs);
    const records: DeferralRecord[] = [];

    for (const [key, value] of this.items) {
      if (value.practiceId !== practiceId) continue;
      const deferUntil = Date.parse(value.deferUntil);
      if (!Number.isFinite(deferUntil) || deferUntil > cutoff) continue;
      records.push(value);
      this.items.delete(key);
    }

    return {
      records,
      deletedCount: records.length,
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

describe('MemoryDeferralStore', () => {
  const baseRecord: DeferralRecord = {
    id: 'def-1',
    practiceId: 'practice-1',
    submissionId: 'sub-1',
    createdAt: '2025-01-01T20:00:00Z',
    summaryCode: 'headache',
    deferUntil: '2025-01-02T08:00:00Z',
  };

  it('enqueues and flushes by deferUntil', async () => {
    const store = new MemoryDeferralStore(() => Date.parse('2025-01-01T20:00:00Z'));
    await store.enqueue(baseRecord, 86_400_000);

    const flushEarly = await store.flushReady('practice-1', '2025-01-01T23:00:00Z');
    expect(flushEarly.records).toHaveLength(0);

    const flushReady = await store.flushReady('practice-1', '2025-01-02T08:00:00Z');
    expect(flushReady.records).toHaveLength(1);
    expect(flushReady.records[0].id).toBe('def-1');
  });

  it('expires records past TTL', async () => {
    const store = new MemoryDeferralStore(() => Date.parse('2025-01-01T20:00:00Z'));
    await store.enqueue(baseRecord, 1_000);
    const expired = await store.expireStale('2025-01-01T20:00:02Z');
    expect(expired).toBe(1);

    const flush = await store.flushReady('practice-1', '2025-01-02T08:00:00Z');
    expect(flush.records).toHaveLength(0);
  });
});
