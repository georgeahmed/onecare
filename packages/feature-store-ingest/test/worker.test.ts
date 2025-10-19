import { describe, expect, it, beforeEach } from 'vitest';

import { MemoryBus } from '@onecare/bus';
import type { IdempotencyStore } from '@onecare/ports';
import { getCounterTotal, getHistogramRecords, resetMetrics } from '@onecare/observability';

import { InMemoryOnlineFeatureStore } from '../../feature-store-online/src/inMemoryOnlineStore';
import { FeatureIngestionWorker } from '../src/worker';

describe('FeatureIngestionWorker', () => {
  class InMemoryIdempotency implements IdempotencyStore {
    store = new Map<string, number | null>();

    prune() {
      const now = Date.now();
      for (const [key, expiresAt] of this.store.entries()) {
        if (expiresAt !== null && expiresAt <= now) {
          this.store.delete(key);
        }
      }
    }

    async exists(key: string): Promise<boolean> {
      this.prune();
      return this.store.has(key);
    }

    async put(key: string, ttlSeconds: number): Promise<void> {
      this.prune();
      const expiresAt = Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null;
      this.store.set(key, expiresAt);
    }

    async reserve(key: string, ttlSeconds: number): Promise<'reserved' | 'exists'> {
      this.prune();
      if (this.store.has(key)) {
        return 'exists';
      }
      const expiresAt = Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null;
      this.store.set(key, expiresAt);
      return 'reserved';
    }

    async delete(key: string): Promise<void> {
      this.store.delete(key);
    }
  }

  let bus: MemoryBus;
  let featureStore: InMemoryOnlineFeatureStore;
  let idempotency: InMemoryIdempotency;

  const basePayload = {
    patientId: 'patient-123',
    generatedAt: '2025-01-12T08:00:00.000Z',
    features: {
      schemaVersion: 'v1.0.0',
      generatedAt: '2025-01-12T08:00:00.000Z',
      acuity: 0.4,
      risk: 0.2,
      complexity: 0.3,
      time: 0.5,
      capacity: 0.1,
      compositeScore: 0.35,
      source: 'unit-test',
    },
  };

  beforeEach(() => {
    resetMetrics();
    bus = new MemoryBus();
    featureStore = new InMemoryOnlineFeatureStore();
    idempotency = new InMemoryIdempotency();
  });

  it('ingests feature events into the online store', async () => {
    const worker = new FeatureIngestionWorker({
      bus,
      featureStore,
      idempotency,
      mappings: [
        {
          topic: 'features.triage-core',
          featureSet: 'triage-core',
          deriveEntityId: (payload: typeof basePayload) => payload.patientId,
          deriveAsOf: (payload: typeof basePayload) => payload.generatedAt,
          mapPayload: (payload: typeof basePayload) => payload.features,
        },
      ],
    }, { backoffMs: 1, jitterMs: 1, retries: 2 });

    await worker.start();
    await bus.publish('features.triage-core', basePayload, {
      'x-correlation-id': 'corr-1',
    });

    const stored = await featureStore.get({ featureSet: 'triage-core', entityId: 'patient-123' });
    expect(stored).not.toBeNull();
    expect(stored?.acuity).toBe(0.4);
    expect(getCounterTotal('features.ingest.ok')).toBeGreaterThan(0);
    const lagRecords = getHistogramRecords('features.freshness.lag_ms');
    expect(lagRecords).toHaveLength(1);
    await worker.stop();
  });

  it('skips duplicate messages based on idempotency key', async () => {
    const worker = new FeatureIngestionWorker({
      bus,
      featureStore,
      idempotency,
      mappings: [
        {
          topic: 'features.triage-core',
          featureSet: 'triage-core',
          deriveEntityId: (payload: typeof basePayload) => payload.patientId,
          deriveAsOf: (payload: typeof basePayload) => payload.generatedAt,
          mapPayload: (payload: typeof basePayload) => payload.features,
        },
      ],
    }, { backoffMs: 1, jitterMs: 1, retries: 0 });

    await worker.start();
    await bus.publish('features.triage-core', basePayload, {
      'x-correlation-id': 'corr-dup',
    });
    await bus.publish('features.triage-core', basePayload, {
      'x-correlation-id': 'corr-dup',
    });

    const metrics = worker.getMetrics();
    expect(metrics.skipped).toBeGreaterThan(0);
    expect(getCounterTotal('features.ingest.ok')).toBe(1);
    await worker.stop();
  });

  it('retries transient failures and eventually succeeds', async () => {
    let attempts = 0;
    const worker = new FeatureIngestionWorker({
      bus,
      featureStore,
      idempotency,
      mappings: [
        {
          topic: 'features.triage-core',
          featureSet: 'triage-core',
          deriveEntityId: (payload: typeof basePayload) => payload.patientId,
          deriveAsOf: (payload: typeof basePayload) => payload.generatedAt,
          mapPayload: (payload: typeof basePayload) => {
            attempts += 1;
            if (attempts < 2) {
              throw new Error('transient');
            }
            return payload.features;
          },
        },
      ],
    }, { retries: 2, backoffMs: 1, jitterMs: 1 });

    await worker.start();
    await bus.publish('features.triage-core', basePayload, {
      'x-correlation-id': 'corr-retry',
    });

    const metrics = worker.getMetrics();
    expect(metrics.retries).toBeGreaterThan(0);
    expect(getCounterTotal('features.ingest.retry')).toBeGreaterThan(0);
    expect(await featureStore.get({ featureSet: 'triage-core', entityId: 'patient-123' })).not.toBeNull();
    await worker.stop();
  });

  it('sends poison messages to DLQ after exhausting retries', async () => {
    const dlqMessages: unknown[] = [];
    await bus.subscribe('features.ingest.dlq', (message) => {
      dlqMessages.push(message.payload);
    });

    const worker = new FeatureIngestionWorker({
      bus,
      featureStore,
      idempotency,
      mappings: [
        {
          topic: 'features.triage-core',
          featureSet: 'triage-core',
          deriveEntityId: (payload: typeof basePayload) => payload.patientId,
          deriveAsOf: (payload: typeof basePayload) => payload.generatedAt,
          mapPayload: () => {
            throw new Error('permanent failure');
          },
        },
      ],
    }, { retries: 1, backoffMs: 1, jitterMs: 1 });

    await worker.start();
    await bus.publish('features.triage-core', basePayload, {
      'x-correlation-id': 'corr-dlq',
    });

    expect(dlqMessages).toHaveLength(1);
    const dlqPayload = dlqMessages[0] as Record<string, unknown>;
    expect(dlqPayload.originalTopic).toBe('features.triage-core');
    expect(dlqPayload.featureSet).toBe('triage-core');
    expect(typeof dlqPayload.entityHash === 'string').toBe(true);
    const metrics = worker.getMetrics();
    expect(metrics.dlq).toBe(1);
    expect(getCounterTotal('features.ingest.dlq')).toBe(1);
    expect(getCounterTotal('features.ingest.error')).toBeGreaterThan(0);
    await worker.stop();
  });
});
