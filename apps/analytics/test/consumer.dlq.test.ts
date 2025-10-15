import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message, MessageBus, Subscription } from '@onecare/bus';
import { MemoryBus } from '@onecare/bus';
import { Topics, createEnvelope } from '@onecare/events';
import type { Metric } from '@onecare/events';
import { AnalyticsConsumer, AnalyticsMetricSinkError } from '../src/consumer';

class DlqAwareBus implements MessageBus {
  private readonly inner = new MemoryBus();
  private readonly deadLetterTopic: string;

  constructor(deadLetterTopic: string = Topics.broker.deadLetter) {
    this.deadLetterTopic = deadLetterTopic;
  }

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (topic === this.deadLetterTopic) {
      await this.inner.publish(topic, payload, headers);
      return;
    }
    try {
      await this.inner.publish(topic, payload, headers);
    } catch (err) {
      const dlqPayload = {
        originalTopic: topic,
        payload,
        headers,
        error: err instanceof Error ? err.message : String(err),
      };
      await this.inner.publish(this.deadLetterTopic, dlqPayload);
      throw err;
    }
  }

  async subscribe<T>(topic: string, handler: (msg: Message<T>) => Promise<void> | void): Promise<Subscription> {
    return this.inner.subscribe(topic, handler);
  }
}

describe('AnalyticsConsumer DLQ integration', () => {
  let bus: DlqAwareBus;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new DlqAwareBus();
    write = vi.fn().mockResolvedValue(undefined);
  });

  it('publishes to DLQ when the sink fails', async () => {
    const dlqEvents: Message<Record<string, unknown>>[] = [];
    await bus.subscribe(Topics.broker.deadLetter, (msg) => {
      dlqEvents.push(msg as Message<Record<string, unknown>>);
    });

    const error = new Error('disk full');
    write.mockRejectedValueOnce(error);

    const consumer = new AnalyticsConsumer({ bus, sink: { write } });
    await consumer.start();

    const metric: Metric = { name: 'requests_total', value: 7 };
    const envelope = createEnvelope(Topics.analytics.metric, metric, 'cid-dlq');

    await expect(bus.publish(Topics.analytics.metric, envelope, { 'x-correlation-id': envelope.correlationId ?? '' })).rejects.toThrow(AnalyticsMetricSinkError);

    expect(dlqEvents).toHaveLength(1);
    expect(dlqEvents[0].topic).toBe(Topics.broker.deadLetter);
    expect(dlqEvents[0].payload).toMatchObject({
      originalTopic: Topics.analytics.metric,
      error: 'failed to persist analytics.metric payload',
    });

    await consumer.stop();
  });
});
