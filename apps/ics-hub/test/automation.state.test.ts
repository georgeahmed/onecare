import { describe, it, expect } from 'vitest';
import { evaluateAutomation, publishAutomationOutputs, type IcsContext } from '../src/application/ics.state';
import type {
  AutomationTriggerConfig,
  AutomationTriggerEvent,
} from '../src/application/automation.rules';
import type { MessageBus } from '@onecare/bus';
import { Topics } from '@onecare/events';

const baseConfig: AutomationTriggerConfig = {
  rules: [
    {
      name: 'repeat-followup',
      category: 'repeat',
      reason: 'repeat_required',
      when: {
        statusEquals: ['completed'],
        tagsIncludeAny: ['repeat'],
      },
      create: {
        priority: 'ROUTINE',
        owner: 'automation',
      },
    },
  ],
};

const baseEvent: AutomationTriggerEvent = {
  topic: 'tasks.updated',
  correlationId: 'corr-1',
  occurredAt: '2025-01-01T00:00:00.000Z',
  current: {
    taskId: 'task-123',
    patientId: 'patient-123',
    status: 'completed',
    tags: ['repeat'],
  },
  previous: {
    status: 'in_progress',
    tags: ['repeat'],
  },
};

class RecordingBus implements MessageBus {
  public publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe() {
    return { unsubscribe: async () => {} };
  }
}

function createContext(): IcsContext {
  return {
    id: 'ctx-1',
    bus: new RecordingBus(),
  };
}

describe('evaluateAutomation helper', () => {
  it('updates context with intents and task creations', () => {
    const ctx = createContext();
    const tasks = evaluateAutomation(ctx, baseEvent, {
      config: baseConfig,
      createTaskId: () => 'new-task-1',
      correlationId: 'corr-override',
      now: () => '2025-01-01T01:00:00.000Z',
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      task: {
        taskId: 'new-task-1',
        patientId: 'patient-123',
        priority: 'ROUTINE',
        owner: 'automation',
      },
      ruleName: 'repeat-followup',
      correlationId: 'corr-override',
      triggeredAt: '2025-01-01T01:00:00.000Z',
    });

    expect(ctx.automationIntents).toHaveLength(1);
    expect(ctx.automationTasks).toHaveLength(1);
    expect(ctx.correlationId).toBe('corr-override');
    expect(ctx.automationConfig?.rules[0].name).toBe('repeat-followup');
  });

  it('returns empty array when rules do not match', () => {
    const ctx = createContext();
    const tasks = evaluateAutomation(ctx, {
      ...baseEvent,
      current: { ...baseEvent.current, tags: ['other'] },
    }, { config: baseConfig });

    expect(tasks).toHaveLength(0);
    expect(ctx.automationIntents).toHaveLength(0);
  });

  it('publishes automation tasks via bus adapter helper', async () => {
    const ctx = createContext();
    evaluateAutomation(ctx, baseEvent, {
      config: baseConfig,
      createTaskId: () => 'new-task-1',
      correlationId: 'corr-publish',
      now: () => '2025-01-01T01:00:00.000Z',
    });

    await publishAutomationOutputs(ctx, { taskPublish: { timeoutMs: 0 }, auditPublish: { timeoutMs: 0 } });

    const bus = ctx.bus as RecordingBus;
    expect(bus.publishes).toHaveLength(2);
    const taskPublish = bus.publishes.find((entry) => entry.topic === Topics.tasks.created);
    expect(taskPublish).toBeTruthy();
    const auditPublish = bus.publishes.find((entry) => entry.topic === Topics.audit.event);
    expect(auditPublish).toBeTruthy();
    expect(ctx.automationPublished).toBe(true);
  });

  it('throws when publishing without bus configured', async () => {
    const ctx = createContext();
    ctx.bus = undefined;
    evaluateAutomation(ctx, baseEvent, { config: baseConfig });
    await expect(publishAutomationOutputs(ctx)).rejects.toThrow('automation_bus_missing');
  });
});
