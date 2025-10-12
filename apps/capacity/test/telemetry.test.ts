import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CachedTelemetrySource,
  InMemoryTelemetrySource,
  collectTelemetrySnapshot,
} from '../src/application/telemetry';
import type { TelemetrySource } from '../src/application/types';

describe('CachedTelemetrySource', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached values within TTL', async () => {
    const base = createStubSource({
      arrivalsPerHour: [20, 40],
      queueDepth: [5, 9],
      noShowRate: [0.1, 0.2],
      staffingLevel: [8, 7],
    });
    const cached = new CachedTelemetrySource(base, { ttlMs: 1_000, now: createNowSequence() });

    const firstArrivals = await cached.getArrivalsPerHour();
    const secondArrivals = await cached.getArrivalsPerHour();

    expect(firstArrivals).toBe(20);
    expect(secondArrivals).toBe(20);
    expect(base.getArrivalsPerHourCallCount()).toBe(1);
  });

  it('refreshes cache after TTL expires', async () => {
    const base = createStubSource({
      arrivalsPerHour: [12, 18],
      queueDepth: [3, 4],
      noShowRate: [0.05, 0.1],
      staffingLevel: [6, 9],
    });
    const now = createNowSequence([0, 999, 1_001]);
    const cached = new CachedTelemetrySource(base, { ttlMs: 1_000, now });

    const firstQueue = await cached.getQueueDepth();
    const secondQueue = await cached.getQueueDepth();
    const thirdQueue = await cached.getQueueDepth();

    expect(firstQueue).toBe(3);
    expect(secondQueue).toBe(3);
    expect(thirdQueue).toBe(4);
    expect(base.getQueueDepthCallCount()).toBe(2);
  });
});

describe('InMemoryTelemetrySource', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('applies variance using provided random function', async () => {
    const random = vi.fn(() => 1); // max variance
    const source = new InMemoryTelemetrySource({
      base: {
        arrivalsPerHour: 10,
        queueDepth: 5,
        noShowRate: 0.1,
        staffingLevel: 6,
      },
      variance: {
        arrivalsPerHour: 2,
        queueDepth: 1,
        noShowRate: 0.05,
        staffingLevel: 3,
      },
      random,
    });

    const arrivals = await source.getArrivalsPerHour();
    const queue = await source.getQueueDepth();
    const noShow = await source.getNoShowRate();
    const staffing = await source.getStaffingLevel();

    expect(arrivals).toBeCloseTo(12, 5);
    expect(queue).toBeCloseTo(6, 5);
    expect(noShow).toBeCloseTo(0.15, 5);
    expect(staffing).toBeCloseTo(9, 5);
  });
});

describe('collectTelemetrySnapshot', () => {
  it('sanitizes negative and invalid values', async () => {
    const source: TelemetrySource = {
      getArrivalsPerHour: async () => -10,
      getQueueDepth: async () => Number.NaN,
      getNoShowRate: async () => 1.2,
      getStaffingLevel: async () => Number.POSITIVE_INFINITY,
    };

    const snapshot = await collectTelemetrySnapshot(source, {
      clock: () => new Date('2025-01-01T00:00:00Z'),
    });

    expect(snapshot.arrivalsPerHour).toBe(0);
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.noShowRate).toBe(0.95);
    expect(snapshot.staffingLevel).toBe(0);
    expect(snapshot.collectedAt).toBe('2025-01-01T00:00:00.000Z');
  });
});

interface StubMetricSequences {
  arrivalsPerHour: number[];
  queueDepth: number[];
  noShowRate: number[];
  staffingLevel: number[];
}

function createStubSource(sequences: StubMetricSequences) {
  let arrivalsIdx = 0;
  let queueIdx = 0;
  let noShowIdx = 0;
  let staffingIdx = 0;
  let arrivalsCalls = 0;
  let queueCalls = 0;

  return {
    async getArrivalsPerHour() {
      arrivalsCalls += 1;
      return sequences.arrivalsPerHour[arrivalsIdx++ % sequences.arrivalsPerHour.length];
    },
    async getQueueDepth() {
      queueCalls += 1;
      return sequences.queueDepth[queueIdx++ % sequences.queueDepth.length];
    },
    async getNoShowRate() {
      return sequences.noShowRate[noShowIdx++ % sequences.noShowRate.length];
    },
    async getStaffingLevel() {
      return sequences.staffingLevel[staffingIdx++ % sequences.staffingLevel.length];
    },
    getArrivalsPerHourCallCount() {
      return arrivalsCalls;
    },
    getQueueDepthCallCount() {
      return queueCalls;
    },
  } as unknown as TelemetrySource & {
    getArrivalsPerHourCallCount(): number;
    getQueueDepthCallCount(): number;
  };
}

function createNowSequence(sequence: number[] = [0, 0, 0]) {
  let index = 0;
  return () => {
    const value = sequence[index] ?? sequence[sequence.length - 1];
    index += 1;
    return value;
  };
}
