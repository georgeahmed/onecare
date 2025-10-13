import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events';
import type { IdempotencyStore } from '@onecare/ports';
import {
  AnalyticsConsumer,
  AnalyticsMetricSinkError,
  AnalyticsMetricValidationError,
} from '../src/consumer';

describe('AnalyticsConsumer', () => {
  let bus: MemoryBus;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new MemoryBus();
    write = vi.fn().mockResolvedValue(undefined);
  });

  function createIdempotencyStore(): IdempotencyStore {
    const keys = new Map<string, boolean>();
    return {
      exists: async (key: string) => keys.has(key),
      put: async (key: string) => {
        keys.set(key, true);
      },
      reserve: async (key: string) => {
        if (keys.has(key)) return 'exists';
        keys.set(key, true);
        return 'reserved';
      },
      delete: async (key: string) => {
        keys.delete(key);
      },
    };
  }

  it('writes valid metrics to the sink', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 42,
      labels: { service: 'booking' },
      timestamp: new Date().toISOString(),
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-123');

    await bus.publish(Topics.analytics.metric, envelope);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(metric);

    await consumer.stop();
  });

  it('rejects invalid metrics before writing to sink', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const invalidMetric = { value: 1 } as unknown as Metric;
    const envelope = createEnvelope(Topics.analytics.metric, invalidMetric, 'cid-456');

    await expect(bus.publish(Topics.analytics.metric, envelope)).rejects.toThrow(AnalyticsMetricValidationError);
    expect(write).not.toHaveBeenCalled();

    await consumer.stop();
  });

  it('wraps sink failures in AnalyticsMetricSinkError', async () => {
    const error = new Error('disk full');
    write.mockRejectedValueOnce(error);
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 1,
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-789');

    await expect(bus.publish(Topics.analytics.metric, envelope)).rejects.toThrow(AnalyticsMetricSinkError);
    expect(write).toHaveBeenCalledTimes(1);

    await consumer.stop();
  });

  it('suppresses duplicate metric writes when envelopes replayed', async () => {
    const store = createIdempotencyStore();
    const consumer = new AnalyticsConsumer({ bus, sink: { write }, idempotencyStore: store, idempotencyTtlSeconds: 60 });
    await consumer.start();

    const metric: Metric = {
      name: 'requests_total',
      value: 5,
      timestamp: new Date().toISOString(),
    };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-idem');

    await bus.publish(Topics.analytics.metric, envelope);
    await bus.publish(Topics.analytics.metric, envelope);

    expect(write).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });
});
