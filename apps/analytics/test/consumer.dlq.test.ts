import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from '@onecare/bus';
import { MemoryBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events';
import { resetMetrics } from '@onecare/observability';
import { AnalyticsConsumer } from '../src/consumer';

describe('AnalyticsConsumer DLQ integration', () => {
  let bus: MemoryBus;
  let write: ReturnType<typeof vi.fn>;
  let dlqEvents: Message<Record<string, unknown>>[];

  beforeEach(() => {
    bus = new MemoryBus();
    write = vi.fn();
    dlqEvents = [];
    void bus.subscribe(Topics.broker.deadLetter, (msg) => {
      dlqEvents.push(msg as Message<Record<string, unknown>>);
    });
    resetMetrics();
  });

  it('publishes to DLQ with minimal payload when sink failures exhaust retries', async () => {
    write.mockRejectedValue(new Error('disk full'));

    const consumer = new AnalyticsConsumer({
      bus,
      sink: { write },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    });
    await consumer.start();

    const metric: Metric = { name: 'requests_total', value: 7 };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-dlq');

    await bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' });

    expect(write).toHaveBeenCalledTimes(2);
    expect(dlqEvents).toHaveLength(1);
    const envelopePayload = dlqEvents[0]?.payload as Record<string, unknown>;
    const dlqPayload =
      envelopePayload && typeof envelopePayload.payload === 'object'
        ? (envelopePayload.payload as Record<string, unknown>)
        : {};
    expect(dlqPayload).toMatchObject({
      cause: 'analytics.metric.persistence_failed',
      originalTopic: Topics.analytics.metric,
      correlationId: envelope.correlationId,
      metricName: metric.name,
    });
    await consumer.stop();
  });
});
