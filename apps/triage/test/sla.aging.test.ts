import { describe, it, expect, vi } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import type { MessageBus, Subscription } from '@onecare/bus';
import type { FhirRepository, QueueNotifier } from '@onecare/ports';
import { InMemoryQueueNotifier } from '@onecare/ports';
import { Topics, type TaskUpdated } from '@onecare/events';
import {
  TriageSlaScheduler,
  type TriageSlaSchedulerOptions,
  type PriorityCode,
} from '../src/sla/aging';

class RecordingBus implements MessageBus {
  public readonly publications: Array<{ topic: string; payload: unknown; headers?: Record<string, string> }> = [];

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    this.publications.push({ topic, payload, headers });
  }

  async subscribe<T>(): Promise<Subscription> {
    return {
      unsubscribe: async () => {},
    };
  }
}

function buildConfig(): ResolvedConfig {
  return {
    practiceId: 'demo',
    sla_targets: {
      routine_initial_response: 'PT1S',
      soon_same_day: 'PT1S',
      urgent_first_contact: 'PT1S',
      stat_immediate: 'PT0.5S',
    },
    triage: {
      aging_interval: 'PT1S',
    },
  } as unknown as ResolvedConfig;
}

function createScheduler(overrides: Partial<TriageSlaSchedulerOptions> = {}): {
  scheduler: TriageSlaScheduler;
  bus: RecordingBus;
  queueNotifier: QueueNotifier & { deliveries: Array<{ queue: string; message: unknown }> };
  updateTask: ReturnType<typeof vi.fn>;
} {
  const bus = new RecordingBus();
  const queueNotifier = new InMemoryQueueNotifier();
  const updateTask = vi.fn<Parameters<NonNullable<FhirRepository['updateTask']>>, Promise<void>>().mockResolvedValue();
  const fhirRepository: FhirRepository = {
    upsertBundle: async () => ({ resourceType: 'Bundle', type: 'collection', entry: [] }),
    createTask: async () => ({ id: 'task', resourceType: 'Task' }),
    createAppointment: async () => ({ id: 'appt', resourceType: 'Appointment' }),
    createDocumentReference: async () => ({ id: 'doc', resourceType: 'DocumentReference' }),
    updateTask,
  };

  const options: TriageSlaSchedulerOptions = {
    config: buildConfig(),
    fhirRepository,
    bus,
    now: overrides.now ?? (() => Date.now()),
    maxTasksPerTick: overrides.maxTasksPerTick ?? 5,
    maxTickDurationMs: overrides.maxTickDurationMs ?? 5_000,
    jitterRatio: overrides.jitterRatio ?? 0,
    agingIntervalOverrideMs: overrides.agingIntervalOverrideMs ?? 200,
    handleSignals: false,
  };

  return {
    scheduler: new TriageSlaScheduler(options),
    bus,
    queueNotifier,
    updateTask,
  };
}

function extractUpdates(bus: RecordingBus): TaskUpdated[] {
  return bus.publications
    .filter((entry) => entry.topic === Topics.tasks.updated)
    .map((entry) => {
      const envelope = entry.payload as { payload?: TaskUpdated };
      return envelope?.payload as TaskUpdated;
    })
    .filter((payload): payload is TaskUpdated => Boolean(payload));
}

describe('TriageSlaScheduler', () => {
  it('escalates priority as thresholds are crossed and publishes updates', async () => {
    const base = Date.parse('2025-01-01T00:00:00.000Z');
    let nowValue = base;
    const { scheduler, bus, queueNotifier, updateTask } = createScheduler({
      now: () => nowValue,
    });
    (scheduler as unknown as { running: boolean }).running = true;
    const runTick = async () => {
      await (scheduler as unknown as { runTick: () => Promise<void> }).runTick();
    };
    const rules = (scheduler as unknown as { rules: Record<string, { thresholdMs: number }> }).rules;
    expect(rules.ROUTINE.thresholdMs).toBe(1_000);

    scheduler.track({
      taskId: 'task-1',
      patientId: 'patient-1',
      priority: 'ROUTINE',
      createdAt: new Date(base).toISOString(),
      queueNotifier,
      queueName: 'triage.default',
    });

    await runTick(); // initial evaluation, no change

    nowValue += 1_100;
    await runTick(); // ROUTINE => SOON

    nowValue += 1_100;
    await runTick(); // SOON => URGENT

    nowValue += 1_100;
    await runTick(); // URGENT => STAT

    nowValue += 600;
    await runTick(); // STAT => breach

    expect(updateTask).toHaveBeenCalledTimes(4);
    const updates = extractUpdates(bus);
    expect(updates).toHaveLength(4);

    const priorities = updates.map((update) => update.priority);
    expect(priorities).toEqual(['SOON', 'URGENT', 'STAT', 'STAT']);

    const reasons = updates.map((update) => update.reason);
    expect(reasons).toEqual(['sla_escalation', 'sla_escalation', 'sla_escalation', 'sla_breach']);

    const breached = updates[updates.length - 1];
    expect(breached.breached).toBe(true);

    const transitionPairs: Array<{ from: PriorityCode | undefined; to: PriorityCode }> = updates.map((update) => ({
      from: update.previousPriority,
      to: update.priority,
    }));
    expect(transitionPairs).toEqual([
      { from: 'ROUTINE', to: 'SOON' },
      { from: 'SOON', to: 'URGENT' },
      { from: 'URGENT', to: 'STAT' },
      { from: undefined, to: 'STAT' },
    ]);

    expect(queueNotifier.deliveries.length).toBeGreaterThanOrEqual(4);
    const remaining = (scheduler as unknown as { records: Map<string, unknown> }).records.size;
    expect(remaining).toBe(0);
  });
});
