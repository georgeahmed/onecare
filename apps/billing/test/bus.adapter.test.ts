import { describe, it, expect } from 'vitest';
import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';
import { publishBillingClaim, publishBillingResponse } from '../src/adapters/bus.adapter';
import type { BillingClaim, BillingResponse } from '@onecare/events';

class RecordingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];
  constructor(private readonly failuresBeforeSuccess = 0, private readonly hangTopic?: string) {}
  private attempts = 0;

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (this.hangTopic && topic === this.hangTopic) {
      this.publishes.push({ topic, payload, headers });
      await new Promise(() => { /* never resolves */ });
      return;
    }
    if (topic !== Topics.broker.deadLetter && this.attempts < this.failuresBeforeSuccess) {
      this.attempts += 1;
      this.publishes.push({ topic, payload, headers });
      throw new Error('transient');
    }
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe(): Promise<{ unsubscribe: () => Promise<void> }> {
    return { unsubscribe: async () => {} };
  }
}

describe('billing bus adapter', () => {
  const claim: BillingClaim = {
    claimId: 'claim-1',
    encounterId: 'enc-1',
    amount: 45,
    currency: 'GBP',
  };
  const response: BillingResponse = {
    claimId: 'claim-1',
    status: 'accepted',
  };

  it('publishes claim and response envelopes on success', async () => {
    const bus = new RecordingBus();
    await publishBillingClaim(bus, claim, 'corr-claim');
    await publishBillingResponse(bus, response, 'corr-response');
    const claimPublish = bus.publishes.find((event) => event.topic === Topics.billing.claim)!;
    expect(claimPublish.headers?.['x-correlation-id']).toBe('corr-claim');
    const responsePublish = bus.publishes.find((event) => event.topic === Topics.billing.response)!;
    expect(responsePublish.headers?.['x-correlation-id']).toBe('corr-response');
  });

  it('routes to DLQ after retry exhaustion', async () => {
    const bus = new RecordingBus(3);
    await publishBillingClaim(bus, claim, 'corr-dlq', { maxRetries: 1, baseDelayMs: 1 });
    const dlqPublish = bus.publishes.find((event) => event.topic === Topics.broker.deadLetter);
    expect(dlqPublish).toBeTruthy();
    const envelope = dlqPublish?.payload as { payload: { originalTopic: string; correlationId?: string; error?: string; payload?: unknown } };
    expect(envelope.payload.originalTopic).toBe(Topics.billing.claim);
    expect(envelope.payload.correlationId).toBe('corr-dlq');
    expect(envelope.payload.error).toBeDefined();
    expect((envelope.payload as { payload?: { redacted?: boolean } }).payload).toMatchObject({ redacted: true });
  });

  it('handles publish timeouts and emits DLQ entry', async () => {
    const bus = new RecordingBus(0, Topics.billing.response);
    await publishBillingResponse(bus, response, 'corr-timeout', { timeoutMs: 5, maxRetries: 0 });
    const dlqPublish = bus.publishes.find((event) => event.topic === Topics.broker.deadLetter);
    expect(dlqPublish).toBeTruthy();
    const envelope = dlqPublish?.payload as { payload: { error?: string; payload?: unknown } };
    expect(envelope.payload.error).toBe('publish_timeout');
    expect((envelope.payload as { payload?: { redacted?: boolean } }).payload).toMatchObject({ redacted: true });
  });
});
