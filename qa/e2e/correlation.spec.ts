import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCorrelationId } from '../../packages/observability/src/otel';
import { logger } from '../../packages/observability/src/logger';
import { publishWithRetry } from '../../apps/orchestrator/src/adapters/busUtil';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import { Topics } from '../../packages/events/src/topics';
import type { TriageInput } from '../../packages/events/src/contracts/triage';
import type { MessageBus } from '../../packages/bus/src/types';
import type { TypedEnvelope } from '../../packages/events/src/envelope-util';
import type { DlqEvent } from '../../packages/events/src/contracts/dlq-event';

interface PublishRecord {
  topic: string;
  payload: unknown;
  headers?: Record<string, string>;
}

class RecordingBus implements MessageBus {
  public readonly records: PublishRecord[] = [];
  private failureTopic: string | null = null;
  private failureError: Error | null = null;

  withFailure(topic: string, error: Error): this {
    this.failureTopic = topic;
    this.failureError = error;
    return this;
  }

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (this.failureTopic === topic && this.failureError) {
      this.records.push({ topic, payload, headers });
      throw this.failureError;
    }
    this.records.push({ topic, payload, headers });
  }

  async subscribe(): Promise<{ unsubscribe(): Promise<void> }> {
    return { unsubscribe: async () => {} };
  }
}

describe('CorrelationId propagation', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setCorrelationId(undefined);
    consoleSpy.mockRestore();
  });

  it('propagates correlationId across logs and successful publishes', async () => {
    const correlationId = 'corr-propagation-1';
    setCorrelationId(correlationId);
    logger.info('handling submission', { component: 'triage' });

    const payload: TriageInput = { patientId: 'pat-1', narrative: 'fever', features: { pulse: 90 } };
    const envelope = createEnvelope(Topics.triage.input, payload, correlationId);
    const bus = new RecordingBus();

    await publishWithRetry({
      bus,
      envelope,
      correlationId,
      timeoutMs: 0,
      maxAttempts: 1,
      baseDelayMs: 0,
      payloadRef: 'triage:pat-1',
    });

    expect(consoleSpy).toHaveBeenCalled();
    const logEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(logEntry.correlationId).toBe(correlationId);

    const primaryPublish = bus.records.find((record) => record.topic === Topics.triage.input);
    expect(primaryPublish).toBeDefined();
    expect(primaryPublish?.headers?.['x-correlation-id']).toBe(correlationId);
    const publishedEnvelope = primaryPublish?.payload as typeof envelope;
    expect(publishedEnvelope.correlationId).toBe(correlationId);
  });

  it('retains correlationId on DLQ when retries are exhausted', async () => {
    const correlationId = 'corr-propagation-2';
    setCorrelationId(correlationId);
    const payload: TriageInput = { patientId: 'pat-2', narrative: 'migraine' };
    const envelope = createEnvelope(Topics.triage.input, payload, correlationId);
    const failure = Object.assign(new Error('handler_failed'), { code: 'handler_failed' });
    const bus = new RecordingBus().withFailure(Topics.triage.input, failure);

    await expect(
      publishWithRetry({
        bus,
        envelope,
        correlationId,
        timeoutMs: 0,
        maxAttempts: 2,
        baseDelayMs: 0,
        payloadRef: 'triage:pat-2',
      }),
    ).rejects.toBe(failure);

    const dlqRecord = bus.records.find((record) => record.topic === Topics.broker.deadLetter);
    expect(dlqRecord).toBeDefined();
    expect(dlqRecord?.headers?.['x-correlation-id']).toBe(correlationId);
    const dlqEnvelope = dlqRecord?.payload as TypedEnvelope<DlqEvent>;
    expect(dlqEnvelope.correlationId).toBe(correlationId);
    expect(dlqEnvelope.payload.correlationId).toBe(correlationId);
  });
});
