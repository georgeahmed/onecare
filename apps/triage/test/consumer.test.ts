import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import { Topics, createEnvelope, type TypedEnvelope, type TriageInput, type DlqEvent } from '@onecare/events';
import type { ResolvedConfig } from '@onecare/config';
import type { IdempotencyStore, QueueNotifier, FhirRepository, FhirResourceRef } from '@onecare/ports';
import { InMemoryQueueNotifier } from '@onecare/ports';
import { TriageConsumer, type TriageConsumerOptions } from '../src/adapters/consumer';
import { resetMetrics, getCounterRecords } from '@onecare/observability';

function buildConfig(): ResolvedConfig {
  return {
    practiceId: 'demo',
    triage: {
      score_weights: {
        acuity: 1,
        risk: 0.5,
        complexity: 0.25,
        time: 0.25,
      },
    },
    priority_thresholds: {
      stat: 0.9,
      urgent: 0.6,
      soon: 0.3,
      routine: 0,
    },
  };
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, number>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string, ttlSeconds: number) => {
      keys.set(key, Date.now() + ttlSeconds * 1_000);
    },
    reserve: async (key: string, ttlSeconds: number) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, Date.now() + ttlSeconds * 1_000);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

function createFhirRepository(overrides: {
  createTask: (task: unknown, options?: unknown) => Promise<FhirResourceRef>;
}): FhirRepository {
  return {
    async upsertBundle() {
      return { resourceType: 'Bundle', type: 'collection', entry: [] };
    },
    createTask: overrides.createTask,
    async createAppointment() {
      throw new Error('not_supported');
    },
    async createDocumentReference() {
      throw new Error('not_supported');
    },
  };
}

async function publishAndWait<T>(bus: MemoryBus, topic: string, payload: T, headers?: Record<string, string>) {
  await bus.publish(topic, payload, headers);
}

describe('TriageConsumer', () => {
  let bus: MemoryBus;
  let config: ResolvedConfig;
  let ingressStore: IdempotencyStore;
  let taskStore: IdempotencyStore;
  let queueNotifier: QueueNotifier & { deliveries: Array<{ queue: string; message: unknown }> };

  beforeEach(() => {
    bus = new MemoryBus();
    config = buildConfig();
    ingressStore = createIdempotencyStore();
    taskStore = createIdempotencyStore();
    queueNotifier = new InMemoryQueueNotifier();
    resetMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createOptions(overrides: Partial<TriageConsumerOptions> = {}): TriageConsumerOptions {
    return {
      bus,
      config,
      fhirRepository: createFhirRepository({
        createTask: async () => ({ id: 'task-001', resourceType: 'Task' }),
      }),
      queueNotifier,
      ingressIdempotencyStore: ingressStore,
      taskIdempotencyStore: taskStore,
      ...overrides,
    };
  }

  it('processes triage input and publishes tasks.created with idempotency metadata', async () => {
    const createTaskMock = vi.fn(async () => ({ id: 'task-123', resourceType: 'Task' }));
    const consumer = new TriageConsumer(
      createOptions({
        fhirRepository: createFhirRepository({ createTask: createTaskMock }),
      }),
    );

    const tasksPublished: Array<{ envelope: TypedEnvelope<unknown>; headers?: Record<string, string> }> = [];
    const tasksSubscription = await bus.subscribe(Topics.tasks.created, (msg) => {
      tasksPublished.push({ envelope: msg.payload as TypedEnvelope<unknown>, headers: msg.headers });
    });

    await consumer.start();

    const payload: TriageInput = {
      patientId: 'patient-123',
      narrative: 'Patient reports shortness of breath.',
      features: {
        acuity: 0.9,
        risk: 0.7,
      },
    };
    const envelope = createEnvelope(Topics.triage.input, payload, 'corr-123');
    const headers = {
      'x-idempotency-key': 'triage-ingress-1',
      'x-message-id': envelope.id,
      'x-correlation-id': 'corr-123',
    };

    await publishAndWait(bus, Topics.triage.input, envelope, headers);

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(queueNotifier.deliveries).toHaveLength(1);
    expect(tasksPublished).toHaveLength(1);

    const first = tasksPublished[0];
    expect(first.envelope.payload).toMatchObject({
      taskId: 'task-123',
      patientId: 'patient-123',
    });
    expect(first.headers).toBeDefined();
    expect(first.headers?.['x-correlation-id']).toBe('corr-123');
    expect(first.headers?.['x-idempotency-key']).toBe('triage-ingress-1');

    await consumer.stop();
    await tasksSubscription.unsubscribe();
  });

  it('retries transient errors before succeeding', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const createTaskMock = vi
      .fn<Parameters<FhirRepository['createTask']>, ReturnType<FhirRepository['createTask']>>()
      .mockRejectedValueOnce(Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' }))
      .mockResolvedValue({ id: 'task-retried', resourceType: 'Task' });

    const consumer = new TriageConsumer(
      createOptions({
        fhirRepository: createFhirRepository({ createTask: createTaskMock }),
      }),
    );

    const tasksPublished: TypedEnvelope<unknown>[] = [];
    const tasksSubscription = await bus.subscribe(Topics.tasks.created, (msg) => {
      tasksPublished.push(msg.payload as TypedEnvelope<unknown>);
    });

    await consumer.start();

    const payload: TriageInput = {
      patientId: 'patient-456',
      narrative: 'Follow-up for persistent cough.',
    };
    const envelope = createEnvelope(Topics.triage.input, payload, 'corr-retry');
    const headers = {
      'x-idempotency-key': 'triage-ingress-retry',
      'x-message-id': envelope.id,
      'x-correlation-id': 'corr-retry',
    };

    const publishPromise = publishAndWait(bus, Topics.triage.input, envelope, headers);
    await vi.runAllTimersAsync();
    await publishPromise;

    expect(createTaskMock).toHaveBeenCalledTimes(2);
    expect(tasksPublished).toHaveLength(1);
    const retryRecords = getCounterRecords('triage.retry');
    expect(retryRecords.at(-1)?.attributes?.code).toBe('upstream_unavailable');

    await consumer.stop();
    await tasksSubscription.unsubscribe();
  });

  it('sends payloads to the DLQ when non-retryable errors persist', async () => {
    const createTaskMock = vi
      .fn<Parameters<FhirRepository['createTask']>, ReturnType<FhirRepository['createTask']>>()
      .mockRejectedValue(Object.assign(new Error('invalid_fhir'), { status: 400 }));

    const consumer = new TriageConsumer(
      createOptions({
        fhirRepository: createFhirRepository({ createTask: createTaskMock }),
        retryAttempts: 2,
      }),
    );

    const dlqMessages: Array<{ envelope: TypedEnvelope<DlqEvent>; headers?: Record<string, string> }> = [];
    const dlqSubscription = await bus.subscribe(Topics.broker.deadLetter, (msg) => {
      dlqMessages.push({ envelope: msg.payload as TypedEnvelope<DlqEvent>, headers: msg.headers });
    });
    const tasksCreated: TypedEnvelope<unknown>[] = [];
    const tasksSubscription = await bus.subscribe(Topics.tasks.created, (msg) => {
      tasksCreated.push(msg.payload as TypedEnvelope<unknown>);
    });

    await consumer.start();

    const payload: TriageInput = {
      patientId: 'patient-789',
      narrative: 'Invalid payload should be rejected.',
    };
    const envelope = createEnvelope(Topics.triage.input, payload, 'corr-dlq');
    const headers = {
      'x-idempotency-key': 'triage-ingress-dlq',
      'x-message-id': envelope.id,
      'x-correlation-id': 'corr-dlq',
    };

    await publishAndWait(bus, Topics.triage.input, envelope, headers);

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(dlqMessages).toHaveLength(1);
    const dlq = dlqMessages[0];
    expect(dlq.envelope.payload.originalTopic).toBe(Topics.triage.input);
    expect(dlq.envelope.payload.errorCode).toBe('invalid_fhir');
    expect(dlq.envelope.payload.correlationId).toBe('corr-dlq');
    expect(dlq.headers?.['x-idempotency-key']).toBe(`triage.input:triage-ingress-dlq`);
    expect(tasksCreated).toHaveLength(0);
    const dlqRecords = getCounterRecords('triage.dlq');
    expect(dlqRecords.at(-1)?.attributes?.code).toBe('invalid_fhir');

    await consumer.stop();
    await dlqSubscription.unsubscribe();
    await tasksSubscription.unsubscribe();
  });
});
