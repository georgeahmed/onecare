import { describe, it, expect } from 'vitest';
import type { MessageBus } from '@onecare/bus';
import { publishWithGuard, publishAutomationTasks, type DLQMessage } from '../src/adapters/bus.adapter';
import { Topics } from '@onecare/events';
import type { AutomationTaskCreation } from '../src/application/automation.rules';

class FlakyBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];
  constructor(private failTimes: number) {}
  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (topic !== Topics.broker.deadLetter && this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error('transient');
    }
    this.publishes.push({ topic, payload, headers });
  }
  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

class HangingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (topic === Topics.broker.deadLetter) {
      this.publishes.push({ topic, payload, headers });
      return;
    }
    this.publishes.push({ topic, payload, headers });
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
    const dlqEnvelope = dlq!.payload as { topic: string; correlationId?: string; payload: DLQMessage };
    expect(dlqEnvelope.topic).toBe(Topics.broker.deadLetter);
    expect(dlqEnvelope.correlationId).toBe('cid-2');
    expect(dlqEnvelope.payload.originalTopic).toBe('ics.referral.ack');
    expect(dlqEnvelope.payload.correlationId).toBe('cid-2');
    expect(dlq!.headers?.['x-original-topic']).toBe('ics.referral.ack');
  });

  it('respects publish timeouts and falls back to DLQ', async () => {
    const bus = new HangingBus();
    await publishWithGuard(bus, 'ics.referral.ack', { ok: true }, 'cid-timeout', { timeoutMs: 5, maxRetries: 1, baseDelayMs: 1 });
    const dlq = bus.publishes.find((p) => p.topic === Topics.broker.deadLetter);
    expect(dlq).toBeTruthy();
    const dlqEnvelope = dlq!.payload as { topic: string; payload: DLQMessage };
    expect(dlqEnvelope.topic).toBe(Topics.broker.deadLetter);
    expect(dlqEnvelope.payload.error).toBe('publish_timeout');
    expect(dlq!.headers?.['x-original-topic']).toBe('ics.referral.ack');
  });
});

class RecordingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

describe('publishAutomationTasks', () => {
  it('publishes tasks.created envelope and audit event for each creation', async () => {
    const bus = new RecordingBus();
    const creations: AutomationTaskCreation[] = [
      {
        task: { taskId: 'new-task-1', patientId: 'patient-1', priority: 'ROUTINE', owner: 'automation' },
        ruleName: 'repeat-followup',
        reason: 'repeat_required',
        category: 'repeat',
        sourceTaskId: 'task-123',
        correlationId: 'corr-1',
        triggeredAt: '2025-01-01T00:00:00.000Z',
        context: {},
      },
    ];

    await publishAutomationTasks(bus, creations, {
      taskPublish: { timeoutMs: 0 },
      auditPublish: { timeoutMs: 0 },
      auditEventType: 'automation.task.created',
      now: () => '2025-01-01T00:00:00.000Z',
    });

    expect(bus.publishes).toHaveLength(2);
    const [taskCall, auditCall] = bus.publishes;

    expect(taskCall.topic).toBe(Topics.tasks.created);
    const taskEnvelope = taskCall.payload as { payload: { taskId: string; patientId: string; priority: string; owner?: string } };
    expect(taskEnvelope.payload).toMatchObject({
      taskId: 'new-task-1',
      patientId: 'patient-1',
      priority: 'ROUTINE',
      owner: 'automation',
    });
    expect(taskCall.headers?.['x-correlation-id']).toBe('corr-1');

    expect(auditCall.topic).toBe(Topics.audit.event);
    const auditEnvelope = auditCall.payload as { payload: { type: string; details?: Record<string, unknown>; correlationId?: string | null } };
    expect(auditEnvelope.payload.type).toBe('automation.task.created');
    expect(auditEnvelope.payload.details).toMatchObject({
      ruleName: 'repeat-followup',
      taskId: 'new-task-1',
      sourceTaskId: 'task-123',
    });
    expect(auditCall.headers?.['x-correlation-id']).toBe('corr-1');
  });

  it('does nothing when no creations provided', async () => {
    const bus = new RecordingBus();
    await publishAutomationTasks(bus, [], { taskPublish: { timeoutMs: 0 } });
    expect(bus.publishes).toHaveLength(0);
  });
});
