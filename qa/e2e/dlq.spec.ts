import { describe, it, expect, beforeEach, vi } from 'vitest';

const delayCalls: number[] = [];

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => {
    delayCalls.push(ms);
    return Promise.resolve();
  },
}));

import { publishWithRetry } from '../../apps/orchestrator/src/adapters/busUtil';
import type { MessageBus } from '../../packages/bus/src/types';
import { Topics } from '../../packages/events/src/topics';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import type { TriageInput } from '../../packages/events/src/contracts/triage';
import type { TypedEnvelope } from '../../packages/events/src/envelope-util';
import type { DlqEvent } from '../../packages/events/src/contracts/dlq-event';
import { validate } from '../../packages/domain/src/schema/validator';

class PoisonBus implements MessageBus {
  public readonly published: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];
  public attempts = 0;

  constructor(private readonly failure: Error) {}

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (topic === Topics.triage.input) {
      this.attempts += 1;
      throw this.failure;
    }
    this.published.push({ topic, payload, headers });
  }

  async subscribe(): Promise<{ unsubscribe(): Promise<void> }> {
    return { unsubscribe: async () => {} };
  }
}

describe('DLQ path verification', () => {
  beforeEach(() => {
    delayCalls.length = 0;
  });

  it('routes poison messages to the DLQ with minimal safe context', async () => {
    const failure = Object.assign(new Error('schema_invalid'), { code: 'schema_invalid' });
    const bus = new PoisonBus(failure);
    const payload: TriageInput = { patientId: 'pat-sensitive', narrative: 'requires urgent care' };
    const envelope = createEnvelope(Topics.triage.input, payload, 'corr-dlq');

    await expect(
      publishWithRetry({
        bus,
        envelope,
        correlationId: 'corr-dlq',
        timeoutMs: 0,
        maxAttempts: 2,
        baseDelayMs: 5,
        payloadRef: 'triage:submission:anonymized',
      }),
    ).rejects.toBe(failure);

    expect(bus.attempts).toBe(2);
    const dlqPublishes = bus.published.filter((entry) => entry.topic === Topics.broker.deadLetter);
    expect(dlqPublishes).toHaveLength(1);

    const dlqEnvelope = dlqPublishes[0].payload as TypedEnvelope<DlqEvent>;
    const envValidation = validate('https://onecare/schemas/common/event-envelope.json', dlqEnvelope);
    expect(envValidation.ok).toBe(true);
    const dlqValidation = validate('https://onecare/schemas/common/dlq-event.json', dlqEnvelope.payload);
    expect(dlqValidation.ok).toBe(true);

    expect(dlqEnvelope.payload).toMatchObject({
      originalTopic: Topics.triage.input,
      correlationId: 'corr-dlq',
      errorCode: 'schema_invalid',
      attempts: 2,
      payloadRef: 'triage:submission:anonymized',
    });

    const serialized = JSON.stringify(dlqEnvelope.payload);
    expect(serialized).not.toMatch(/pat-sensitive/i);
    expect(serialized).not.toMatch(/requires urgent care/i);
  });

  it('records exponential backoff timings when retries are exhausted', async () => {
    const failure = Object.assign(new Error('temporarily_unavailable'), { code: 'temporarily_unavailable' });
    const bus = new PoisonBus(failure);
    const payload: TriageInput = { patientId: 'pat-2', narrative: 'headache' };
    const envelope = createEnvelope(Topics.triage.input, payload, 'corr-dlq-2');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await expect(
        publishWithRetry({
          bus,
          envelope,
          correlationId: 'corr-dlq-2',
          timeoutMs: 0,
          maxAttempts: 3,
          baseDelayMs: 10,
          payloadRef: { submissionId: 'safe-ref' },
        }),
      ).rejects.toBe(failure);
    } finally {
      randomSpy.mockRestore();
    }

    expect(delayCalls).toEqual([10, 20]);
    const dlqPublishes = bus.published.filter((entry) => entry.topic === Topics.broker.deadLetter);
    expect(dlqPublishes).toHaveLength(1);
    const dlqEnvelope = dlqPublishes[0].payload as TypedEnvelope<DlqEvent>;
    expect(dlqEnvelope.payload.attempts).toBe(3);
  });
});
