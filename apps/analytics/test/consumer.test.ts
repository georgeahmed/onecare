import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events/src/contracts/metric';
import { AnalyticsConsumer } from '../src/consumer';

describe('AnalyticsConsumer', () => {
  let bus: MemoryBus;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new MemoryBus();
    write = vi.fn().mockResolvedValue(undefined);
  });

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
  });

  it('rejects invalid metrics before writing to sink', async () => {
    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const invalidMetric = { value: 1 } as unknown as Metric;
    const envelope = createEnvelope(Topics.analytics.metric, invalidMetric, 'cid-456');

    await expect(bus.publish(Topics.analytics.metric, envelope)).rejects.toThrow(
      'analytics.metric payload failed validation'
    );
    expect(write).not.toHaveBeenCalled();
  });
});
