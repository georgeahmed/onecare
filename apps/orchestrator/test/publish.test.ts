import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MessageBus } from '@onecare/bus';
import { Topics, createEnvelope, type TypedEnvelope } from '@onecare/events';
import { resetMetrics, getCounterRecords, getHistogramRecords } from '@onecare/observability';
import { publishWithRetry } from '../src/adapters/busUtil';

interface PublishedMessage {
  topic: string;
  payload: unknown;
  headers?: Record<string, string>;
}

class FailingBus implements MessageBus {
  private attempt = 0;
  public readonly published: PublishedMessage[] = [];
  public readonly dlq: PublishedMessage[] = [];

  constructor(private readonly failuresBeforeSuccess: number, private readonly errorMessage = 'transient failure') {}

  async publish(topic: string, payload: unknown, headers?: Record<string, string>): Promise<void> {
    if (topic === Topics.broker.deadLetter) {
      this.dlq.push({ topic, payload, headers });
      return;
    }

    this.attempt += 1;
    if (this.attempt <= this.failuresBeforeSuccess) {
      const err = new Error(this.errorMessage);
      (err as { code?: string }).code = 'publish_failed';
      throw err;
    }
    this.published.push({ topic, payload, headers });
  }

  async subscribe(): Promise<{ unsubscribe(): void }> {
    throw new Error('not implemented');
  }
}

describe('publishWithRetry', () => {
  beforeEach(() => {
    resetMetrics();
    vi.spyOn(Math, 'random').mockReturnValue(0); // remove jitter for determinism
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries transient failures then succeeds', async () => {
    const bus = new FailingBus(1);
    const envelope = createEnvelope(Topics.triage.input, { hello: 'world' }, 'corr-123');

    await publishWithRetry({
      bus,
      envelope,
      correlationId: 'corr-123',
      idempotencyKey: 'idem-1',
      timeoutMs: 50,
      maxAttempts: 3,
      baseDelayMs: 0,
      payloadRef: { ref: 'test' },
    });

    expect(bus.published).toHaveLength(1);
    expect(bus.dlq).toHaveLength(0);
    const publishOk = getCounterRecords('publish.ok');
    expect(publishOk).toHaveLength(1);
    expect(publishOk[0].attributes).toMatchObject({ topic: Topics.triage.input, attempts: 2 });
    const publishRetry = getCounterRecords('publish.retry');
    expect(publishRetry).toHaveLength(1);
    expect(publishRetry[0].attributes).toMatchObject({ topic: Topics.triage.input, attempt: 1 });
    expect(getCounterRecords('publish.fail')).toHaveLength(0);
    const durationRecords = getHistogramRecords('publish.duration');
    expect(durationRecords).toHaveLength(1);
    expect(durationRecords[0].attributes).toMatchObject({ topic: Topics.triage.input });
  });

  it('routes to DLQ after exhausting attempts', async () => {
    const bus = new FailingBus(Number.POSITIVE_INFINITY, 'upstream down');
    const envelope: TypedEnvelope<{ hello: string }> = createEnvelope(
      Topics.triage.input,
      { hello: 'world' },
      'corr-dlq',
    );

    await expect(
      publishWithRetry({
        bus,
        envelope,
        correlationId: 'corr-dlq',
        timeoutMs: 10,
        maxAttempts: 2,
        baseDelayMs: 0,
        payloadRef: { ref: 'triage', requestId: 'req-1' },
      }),
    ).rejects.toThrow();

    expect(bus.published).toHaveLength(0);
    expect(bus.dlq).toHaveLength(1);
    const dlqEntry = bus.dlq[0];
    expect(dlqEntry.topic).toBe(Topics.broker.deadLetter);

    const dlqEnvelope = dlqEntry.payload as TypedEnvelope<DlqPayload>;
    expect(dlqEnvelope.payload.originalTopic).toBe(Topics.triage.input);
    expect(dlqEnvelope.payload.correlationId).toBe('corr-dlq');
    expect(dlqEnvelope.payload.attempts).toBe(2);
    expect(dlqEnvelope.payload.payloadRef).toMatchObject({ ref: 'triage', requestId: 'req-1' });

    const failures = getCounterRecords('publish.fail');
    expect(failures).toHaveLength(1);
    expect(failures[0].attributes).toMatchObject({ topic: Topics.triage.input, attempts: 2 });
  });
});

interface DlqPayload {
  originalTopic: string;
  correlationId?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts?: number;
  payloadRef?: Record<string, unknown> | string;
  ts: string;
}
