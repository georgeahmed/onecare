import { describe, it, expect, vi } from 'vitest';

import type { MessageBus } from '@onecare/bus';
import { Topics, type PortalNotify, type TypedEnvelope, type DlqEvent } from '@onecare/events';

import {
  ReliablePortalNotifyPublisher,
  PortalNotifyValidationError,
  type PortalNotifyPublishRequest,
} from '../src/adapters/portal-notifier';

class StubBus implements MessageBus {
  public readonly published: Array<{ topic: string; payload: unknown; headers?: Record<string, string> }> = [];
  public failures = new Map<string, number>();

  async publish(topic: string, payload: unknown, headers?: Record<string, string>): Promise<void> {
    const remaining = this.failures.get(topic) ?? 0;
    if (remaining > 0) {
      this.failures.set(topic, remaining - 1);
      const error = new Error('transient failure');
      (error as { code?: string }).code = 'ETIMEDOUT';
      throw error;
    }
    this.published.push({ topic, payload, headers });
  }
}

function buildRequest(overrides: Partial<PortalNotifyPublishRequest> = {}): PortalNotifyPublishRequest {
  return {
    practiceId: 'prac-001',
    state: 'UP',
    reasonCode: 'CORE_HOURS',
    at: '2025-01-01T08:15:45Z',
    correlationId: 'corr-test',
    ...overrides,
  };
}

describe('ReliablePortalNotifyPublisher', () => {
  it('publishes envelope with idempotency header', async () => {
    const bus = new StubBus();
    const publisher = new ReliablePortalNotifyPublisher({
      bus,
      sleep: async () => {},
      random: () => 0,
      now: () => new Date('2025-01-01T08:16:00Z'),
    });

    await publisher.publish(buildRequest());

    expect(bus.published).toHaveLength(1);
    const entry = bus.published[0];
    expect(entry.topic).toBe(Topics.portal.notify);

    const envelope = entry.payload as TypedEnvelope<PortalNotify>;
    expect(envelope.correlationId).toBe('corr-test');
    expect(envelope.payload).toEqual({
      practiceId: 'prac-001',
      state: 'UP',
      reasonCode: 'CORE_HOURS',
      at: '2025-01-01T08:15:45Z',
    });

    expect(entry.headers).toMatchObject({
      'x-correlation-id': 'corr-test',
      'x-idempotency-key': 'portal.notify:prac-001:UP:2025-01-01T08:15:00Z',
    });
  });

  it('retries on retryable failure before succeeding', async () => {
    const bus = new StubBus();
    bus.failures.set(Topics.portal.notify, 1);
    const sleep = vi.fn(async () => {});

    const publisher = new ReliablePortalNotifyPublisher({
      bus,
      sleep,
      random: () => 0,
      now: () => new Date('2025-01-01T08:16:00Z'),
    });

    await publisher.publish(buildRequest());

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].topic).toBe(Topics.portal.notify);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('routes to DLQ after retries exhausted', async () => {
    const bus = new StubBus();
    bus.failures.set(Topics.portal.notify, 5);

    const publisher = new ReliablePortalNotifyPublisher({
      bus,
      sleep: async () => {},
      random: () => 0.5,
      now: () => new Date('2025-01-01T08:16:00Z'),
      maxAttempts: 2,
      baseDelayMs: 100,
    });

    await expect(publisher.publish(buildRequest())).resolves.toBeUndefined();

    expect(bus.published).toHaveLength(1);
    const entry = bus.published[0];
    expect(entry.topic).toBe(Topics.broker.deadLetter);

    const dlqPayload = entry.payload as DlqEvent;
    expect(dlqPayload.originalTopic).toBe(Topics.portal.notify);
    expect(dlqPayload.correlationId).toBe('corr-test');
    expect(dlqPayload.payloadRef).toMatchObject({
      practiceId: 'prac-001',
      state: 'UP',
      idempotencyKey: 'portal.notify:prac-001:UP:2025-01-01T08:15:00Z',
    });
    expect(dlqPayload.ts).toBe('2025-01-01T08:16:00.000Z');
  });

  it('throws validation error when payload invalid', async () => {
    const bus = new StubBus();
    const publisher = new ReliablePortalNotifyPublisher({
      bus,
      sleep: async () => {},
    });

    await expect(publisher.publish(buildRequest({ practiceId: 'invalid id' }))).rejects.toBeInstanceOf(
      PortalNotifyValidationError,
    );
    expect(bus.published).toHaveLength(0);
  });
});
