import { describe, it, expect } from 'vitest';
import type { MessageBus } from '@onecare/bus';
import { publishWithGuard } from '../src/adapters/bus.adapter';
import { Topics } from '@onecare/events';

class FlakyBus implements MessageBus {
  public publishes: { topic: string; payload: unknown }[] = [];
  constructor(private failTimes: number) {}
  async publish<T>(topic: string, payload: T): Promise<void> {
    if (topic !== Topics.broker.deadLetter && this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('transient');
    }
    this.publishes.push({ topic, payload });
  }
  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

class HangingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown }[] = [];

  async publish<T>(topic: string, payload: T): Promise<void> {
    if (topic === Topics.broker.deadLetter) {
      this.publishes.push({ topic, payload });
      return;
    }
    this.publishes.push({ topic, payload });
    await new Promise(() => { /* never resolves */ });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

describe('publishWithGuard', () => {
  it('retries and succeeds before DLQ', async () => {
    const bus = new FlakyBus(2);
    await publishWithGuard(bus, 'ics.referral.ack', { ok: true }, 'cid-1', { maxRetries: 3, baseDelayMs: 1 });
    const ok = bus.publishes.find(p => p.topic === 'ics.referral.ack');
    expect(ok).toBeTruthy();
  });

  it('publishes to DLQ after persistent failure', async () => {
    const bus = new FlakyBus(10);
    await publishWithGuard(bus, 'ics.referral.ack', { ok: false }, 'cid-2', { maxRetries: 1, baseDelayMs: 1 });
    const dlq = bus.publishes.find(p => p.topic === Topics.broker.deadLetter);
    expect(dlq).toBeTruthy();
    expect((dlq!.payload as any).originalTopic).toBe('ics.referral.ack');
    expect((dlq!.payload as any).correlationId).toBe('cid-2');
  });

  it('respects publish timeouts and falls back to DLQ', async () => {
    const bus = new HangingBus();
    await publishWithGuard(bus, 'ics.referral.ack', { ok: true }, 'cid-timeout', { timeoutMs: 5, maxRetries: 1, baseDelayMs: 1 });
    const dlq = bus.publishes.find((p) => p.topic === Topics.broker.deadLetter);
    expect(dlq).toBeTruthy();
    expect((dlq!.payload as any).error).toBe('publish_timeout');
  });
});
