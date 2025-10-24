#!/usr/bin/env tsx
import { performance } from 'node:perf_hooks';
import { processDeferrals, type PortalGuardDependencies } from '../src/scheduler';
import type { DeferralRecord, DeferralStore } from '@onecare/ports';
import type { ResolvedConfig } from '@onecare/config';

interface Args {
  records: number;
}

function parseArgs(argv: string[]): Args {
  const defaults: Args = { records: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--records' || arg === '-r') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        defaults.records = Math.floor(parsed);
      }
      i += 1;
    }
  }
  return defaults;
}

class MemoryDeferralStore implements DeferralStore {
  private readonly items = new Map<string, { record: DeferralRecord; expiresAt: number }>();

  constructor(records: DeferralRecord[]) {
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

async function main() {
  const { records: recordCount } = parseArgs(process.argv.slice(2));
  const now = new Date();
  const practiceId = 'practice-1';
  const correlationId = `perf-${Date.now()}`;

  const records: DeferralRecord[] = Array.from({ length: recordCount }, (_value, index) => {
    const deferUntil = new Date(now.getTime() - 5 * 60 * 1000 + index).toISOString();
    return {
      id: `${practiceId}:submission-${index}`,
      practiceId,
      submissionId: `submission-${index}`,
      createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      summaryCode: 'follow_up',
      deferUntil,
    };
  });

  const store = new MemoryDeferralStore(records);
  let published = 0;

  const deps: PortalGuardDependencies = {
    loadConfig: async () =>
      ({
        practiceId,
        core_hours: { start: '08:00', end: '18:00' },
      }) as unknown as ResolvedConfig,
    adapter: {
      getState: async () => ({ portalOpen: true, acceptsSubmissions: true }),
      applyIntents: async () => {},
    },
    deferralStore: store,
    deferralPublisher: {
      publish: async () => {
        published += 1;
      },
    },
  };

  const decision = {
    reason: 'within_hours',
    desiredState: { portalOpen: true, acceptsSubmissions: true },
    intents: [],
    changed: false,
    localDateTime: { isoDate: now.toISOString().slice(0, 10), minutesOfDay: now.getHours() * 60 + now.getMinutes() },
  } as const;

  const start = performance.now();
  await processDeferrals(practiceId, now, correlationId, decision, deps);
  const elapsedMs = performance.now() - start;
  const throughput = recordCount / (elapsedMs / 1000);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        records: recordCount,
        elapsedMs: Number(elapsedMs.toFixed(3)),
        throughputPerSecond: Number(throughput.toFixed(2)),
        published,
        correlationId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
