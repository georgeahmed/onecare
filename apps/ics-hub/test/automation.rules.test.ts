import { describe, it, expect } from 'vitest';
import {
  evaluateAutomationTriggers,
  buildAutomationTaskCreations,
  loadAutomationConfig,
  type AutomationTriggerConfig,
  type AutomationTriggerEvent,
} from '../src/application/automation.rules';

function buildEvent(overrides: Partial<AutomationTriggerEvent> = {}): AutomationTriggerEvent {
  return {
    topic: overrides.topic ?? 'tasks.updated',
    correlationId: overrides.correlationId ?? 'corr-1',
    occurredAt: overrides.occurredAt ?? '2025-01-01T00:00:00.000Z',
    current: {
      taskId: 'task-123',
      patientId: 'patient-123',
      status: 'completed',
      priority: 'ROUTINE',
      tags: ['repeat'],
      metadata: { template: 'repeat-followup', docsMissing: true },
      ...(overrides.current ?? {}),
    },
    previous: overrides.previous ?? {
      status: 'in_progress',
      tags: ['repeat'],
      metadata: { template: 'repeat-followup', docsMissing: false },
    },
  };
}

describe('automation rules evaluation', () => {
  it('produces intents when rules match status change and tag filters', () => {
    const config: AutomationTriggerConfig = {
      rules: [
        {
          name: 'repeat-followup',
          category: 'repeat',
          reason: 'repeat_check_due',
          when: {
            statusEquals: ['completed'],
            tagsIncludeAny: ['repeat'],
          },
          create: {
            priority: 'ROUTINE',
            owner: 'automation-bot',
          },
        },
      ],
    };

    const event = buildEvent();
    const intents = evaluateAutomationTriggers(event, config);

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      ruleName: 'repeat-followup',
      reason: 'repeat_check_due',
      payload: { patientId: 'patient-123', priority: 'ROUTINE', owner: 'automation-bot' },
      context: expect.objectContaining({ triggerStatus: 'completed', previousStatus: 'in_progress' }),
    });
  });

  it('skips rules when status is unchanged to avoid duplicates', () => {
    const config: AutomationTriggerConfig = {
      rules: [
        {
          name: 'repeat-followup',
          category: 'repeat',
          reason: 'repeat_check_due',
          when: {
            statusEquals: ['completed'],
            requireStatusChange: true,
          },
          create: {
            priority: 'ROUTINE',
          },
        },
      ],
    };

    const event = buildEvent({
      previous: {
        status: 'completed',
      },
    });

    const intents = evaluateAutomationTriggers(event, config);
    expect(intents).toHaveLength(0);
  });

  it('supports pathEquals and pathChanged conditions', () => {
    const config: AutomationTriggerConfig = {
      rules: [
        {
          name: 'documentation-missing',
          category: 'documentation',
          reason: 'docs_missing',
          when: {
            statusEquals: ['completed'],
            pathEquals: [{ path: 'metadata.docsMissing', equals: true }],
            pathChanged: ['metadata.docsMissing'],
          },
          create: {
            priority: 'URGENT',
          },
        },
      ],
    };

    const event = buildEvent({
      current: {
        metadata: { docsMissing: true },
      },
      previous: {
        metadata: { docsMissing: false },
      },
    });

    const intents = evaluateAutomationTriggers(event, config);
    expect(intents).toHaveLength(1);
    expect(intents[0].payload.priority).toBe('URGENT');
  });
});

describe('automation task creation builder', () => {
  it('creates task payloads with provenance', () => {
    const event = buildEvent();
    const config: AutomationTriggerConfig = {
      rules: [
        {
          name: 'repeat-followup',
          category: 'repeat',
          reason: 'repeat_check_due',
          when: {
            statusEquals: ['completed'],
          },
          create: {
            priority: 'SOON',
            owner: 'automation',
          },
        },
      ],
    };

    const intents = evaluateAutomationTriggers(event, config);
    const tasks = buildAutomationTaskCreations(intents, {
      createTaskId: () => 'new-task-1',
      correlationId: 'corr-abc',
      now: () => '2025-01-01T01:00:00.000Z',
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      ruleName: 'repeat-followup',
      reason: 'repeat_check_due',
      correlationId: 'corr-abc',
      triggeredAt: '2025-01-01T01:00:00.000Z',
      task: {
        taskId: 'new-task-1',
        patientId: 'patient-123',
        priority: 'SOON',
        owner: 'automation',
      },
    });
  });
});

describe('automation config loader', () => {
  it('parses configuration from JSON string', () => {
    const json = JSON.stringify({
      rules: [
        {
          name: 'doc-trigger',
          category: 'documentation',
          reason: 'missing_documentation',
          when: {
            statusEquals: ['completed'],
            tagsIncludeAll: ['docs'],
          },
          create: {
            priority: 'URGENT',
            owner: 'doc-bot',
          },
        },
      ],
    });

    const config = loadAutomationConfig({ json });
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]).toMatchObject({
      name: 'doc-trigger',
      category: 'documentation',
      create: { priority: 'URGENT', owner: 'doc-bot', copyPatientId: true },
      when: expect.objectContaining({ statusEquals: ['completed'] }),
    });
  });
});
