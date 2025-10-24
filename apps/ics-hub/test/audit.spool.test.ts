import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';
import { AuditSpool } from '../src/application/audit.spool';

class RecordingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

class FlakyBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  constructor(private failures: number) {}

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('transient');
    }
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

const auditEvent = (type: string) => ({
  type,
  timestamp: new Date().toISOString(),
  correlationId: null,
  actor: null,
  details: {},
});

describe('AuditSpool', () => {
  beforeEach(() => {
    // reset any global counters between tests by creating fresh instances only
  });

  it('publishes queued audit events', async () => {
    const bus = new RecordingBus();
    const spool = new AuditSpool(() => bus, { sleep: async () => {} });

    spool.enqueue(auditEvent('ics.test.received'), 'corr-1');
    spool.enqueue(auditEvent('ics.test.decided'), 'corr-1');
    await spool.flush();

    expect(bus.publishes).toHaveLength(2);
    expect(bus.publishes[0].topic).toBe(Topics.audit.event);
    expect(spool.getStats().published).toBe(2);
  });

  it('drops events when queue is full', async () => {
    const bus = new RecordingBus();
    const spool = new AuditSpool(() => bus, { maxSize: 1, sleep: async () => {} });

    spool.enqueue(auditEvent('ics.test.one'), 'corr-1');
    spool.enqueue(auditEvent('ics.test.two'), 'corr-2');
    await spool.flush();

    const stats = spool.getStats();
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.published).toBe(1);
  });

  it('retries publish attempts and eventually succeeds', async () => {
    const bus = new FlakyBus(1);
    const spool = new AuditSpool(() => bus, {
      sleep: async () => {},
      retryDelayMs: 10,
      maxAttempts: 3,
    });

    spool.enqueue(auditEvent('ics.retry.example'), 'corr-retry');
    await spool.flush();

    expect(bus.publishes).toHaveLength(1);
    const stats = spool.getStats();
    expect(stats.published).toBe(1);
    expect(stats.dropped).toBe(0);
  });

  it('drops events after exhausting max attempts', async () => {
    const bus = new FlakyBus(5);
    const spool = new AuditSpool(() => bus, {
      sleep: async () => {},
      retryDelayMs: 10,
      maxAttempts: 1,
    });

    spool.enqueue(auditEvent('ics.retry.fail'), 'corr-fail');
    await spool.flush();

    const stats = spool.getStats();
    expect(stats.dropped).toBeGreaterThan(0);
    expect(bus.publishes).toHaveLength(0);
  });
});
