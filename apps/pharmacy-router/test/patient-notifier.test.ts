import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MessageBus, Subscription } from '@onecare/bus';
import { Topics, type TypedEnvelope, type PharmacyNotification } from '@onecare/events';
import { PatientNotificationAdapter } from '../src/adapters/patient-notifier';
import type { PatientNotification } from '../src/application/pharmacy.state';

class TestBus implements MessageBus {
  public readonly published: Array<{ topic: string; payload: TypedEnvelope<PharmacyNotification>; headers?: Record<string, string> }> = [];

  constructor(private failures: number = 0) {}

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('transient');
    }
    this.published.push({ topic, payload: payload as TypedEnvelope<PharmacyNotification>, headers });
  }

  async subscribe(): Promise<Subscription> {
    return {
      unsubscribe: async () => {},
    };
  }
}

function buildNotification(overrides: Partial<PatientNotification> = {}): PatientNotification {
  return {
    serviceRequestId: 'sr-123',
    organisationId: 'pharmacy/demo',
    summary: ' Pharmacy referral accepted ',
    status: 'accepted',
    correlationId: 'corr-1',
    idempotencyKey: 'pharmacy:notify:demo:sr-123',
    channel: 'unknown',
    metadata: { template: 'pharmacy_referral_status', locale: 'en' },
    ...overrides,
  };
}

describe('PatientNotificationAdapter', () => {
  let bus: TestBus;

  beforeEach(() => {
    bus = new TestBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes minimal notification when consent granted', async () => {
    const adapter = new PatientNotificationAdapter({
      bus,
      consentEvaluator: async () => true,
    });

    await adapter.notifyReferral(buildNotification());

    expect(bus.published).toHaveLength(1);
    const [message] = bus.published;
    expect(message.topic).toBe(Topics.pharmacy.notification);
    expect(message.headers).toMatchObject({ 'x-idempotency-key': 'pharmacy:notify:demo:sr-123' });
    expect(message.payload.payload).toMatchObject({
      serviceRequestId: 'sr-123',
      organisationId: 'pharmacy/demo',
      status: 'accepted',
      summary: 'Pharmacy referral accepted',
      channel: 'unknown',
      metadata: { template: 'pharmacy_referral_status', locale: 'en' },
    });
  });

  it('skips publication when consent denied', async () => {
    const adapter = new PatientNotificationAdapter({
      bus,
      consentEvaluator: async () => false,
    });

    await adapter.notifyReferral(buildNotification());

    expect(bus.published).toHaveLength(0);
  });

  it('retries transient publish failures with backoff', async () => {
    vi.useFakeTimers();
    bus = new TestBus(1);
    const adapter = new PatientNotificationAdapter({
      bus,
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 10,
      jitterRatio: 0,
    });

    const promise = adapter.notifyReferral(buildNotification());
    await vi.runAllTimersAsync();
    await promise;

    expect(bus.published).toHaveLength(1);
  });

  it('throws after exhausting retries', async () => {
    vi.useFakeTimers();
    bus = new TestBus(3);
    const adapter = new PatientNotificationAdapter({
      bus,
      maxAttempts: 2,
      baseDelayMs: 5,
      maxDelayMs: 5,
      jitterRatio: 0,
    });

    const promise = adapter.notifyReferral(buildNotification());
    const expectation = expect(promise).rejects.toThrow('transient');
    await vi.runAllTimersAsync();
    await expectation;
    expect(bus.published).toHaveLength(0);
  });
});
