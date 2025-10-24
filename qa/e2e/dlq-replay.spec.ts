import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageBus } from '../../packages/bus/src/types';
import { Topics } from '../../packages/events/src/topics';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import type { TypedEnvelope } from '../../packages/events/src/envelope-util';
import type { IdempotencyStore } from '@onecare/ports';
import { replayDlqMessage, type DLQEnvelope } from '../../apps/ics-hub/src/dev/replay';

class RecordingBus implements MessageBus {
  public calls: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.calls.push({ topic, payload, headers });
  }

  async subscribe(): Promise<{ unsubscribe(): Promise<void> }> {
    return { unsubscribe: async () => {} };
  }
}

class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, number>();

  async exists(key: string): Promise<boolean> {
    const expires = this.store.get(key);
    if (!expires) return false;
    if (expires < Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async put(key: string, ttlSeconds: number): Promise<void> {
    const expires = Date.now() + Math.max(0, ttlSeconds) * 1_000;
    this.store.set(key, expires);
  }
}

describe('DLQ replay E2E harness', () => {
  let bus: RecordingBus;
  let dlq: DLQEnvelope;
  let originalPayload: unknown;

  beforeEach(() => {
    bus = new RecordingBus();
    const taskEnvelope = createEnvelope(
      Topics.tasks.created,
      {
        taskId: 'task-alpha-001',
        patientId: 'patient-alpha',
        priority: 'ROUTINE',
      },
      'corr-original',
    );
    originalPayload = taskEnvelope.payload;
    dlq = {
      originalTopic: taskEnvelope.topic,
      payload: taskEnvelope.payload,
      correlationId: taskEnvelope.correlationId,
      error: 'schema_invalid',
      ts: new Date().toISOString(),
    } satisfies DLQEnvelope;
  });

  it('replays DLQ payload onto original topic and preserves correlation', async () => {
    await replayDlqMessage(bus, dlq);

    expect(bus.calls).toHaveLength(1);
    const [{ topic, payload, headers }] = bus.calls;
    expect(topic).toBe(dlq.originalTopic);
    expect(headers?.['x-original-topic']).toBe(dlq.originalTopic);
    expect(headers?.['x-correlation-id']).toBe(`${dlq.correlationId}:replay`);

    const envelope = payload as TypedEnvelope<unknown>;
    expect(envelope.correlationId).toBe(`${dlq.correlationId}:replay`);
    expect(envelope.payload).toEqual(originalPayload);
  });

  it('skips duplicates when an idempotency store is configured', async () => {
    const store = new InMemoryIdempotencyStore();
    await replayDlqMessage(bus, dlq, { idempotencyStore: store, ttlSeconds: 60 });
    await replayDlqMessage(bus, dlq, { idempotencyStore: store, ttlSeconds: 60 });

    expect(bus.calls).toHaveLength(1);
  });
});
