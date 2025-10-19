import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MessageBus } from '@onecare/bus';
import { MemoryBus } from '@onecare/bus';
import type { ResolvedConfig } from '@onecare/config';
import type { FhirRepository, QueueNotifier, IdempotencyStore } from '@onecare/ports';
import { InMemoryQueueNotifier } from '@onecare/ports';
import { startTriageRuntime, type TriageRuntime } from '../src/runtime';

function buildConfig(): ResolvedConfig {
  return {
    practiceId: 'demo',
    triage: {
      score_weights: { acuity: 1 },
      aging_interval: 'PT1S',
    },
    priority_thresholds: {
      stat: 0.9,
      urgent: 0.7,
      soon: 0.4,
      routine: 0,
    },
    sla_targets: {
      routine_initial_response: 'PT1S',
      soon_same_day: 'PT1S',
      urgent_first_contact: 'PT1S',
      stat_immediate: 'PT0.5S',
    },
  } as unknown as ResolvedConfig;
}

function createBus(): MessageBus {
  return new MemoryBus();
}

function createFhirRepository(): FhirRepository {
  return {
    upsertBundle: vi.fn(),
    createTask: vi.fn().mockResolvedValue({ id: 'task', resourceType: 'Task' }),
    createAppointment: vi.fn(),
    createDocumentReference: vi.fn(),
    readResource: vi.fn().mockResolvedValue({ resourceType: 'CapabilityStatement' }),
  };
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, boolean>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string) => {
      keys.set(key, true);
    },
    reserve: async (key: string) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, true);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

async function requestJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

describe('triage runtime probes', () => {
  let runtime: TriageRuntime | null = null;
  let queueNotifier: QueueNotifier;
  let ingressStore: IdempotencyStore;

  beforeEach(() => {
    queueNotifier = new InMemoryQueueNotifier();
    ingressStore = createIdempotencyStore();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.stop();
      runtime = null;
    }
  });

  it('exposes healthy probes when dependencies respond', async () => {
    const config = buildConfig();
    const fhirRepository = createFhirRepository();
    runtime = await startTriageRuntime({
      config,
      fhirRepository,
      queueNotifier,
      ingressIdempotencyStore: ingressStore,
      bus: createBus(),
      readinessCacheMs: 100,
      port: 0,
    });

    const health = await requestJson(runtime.port, '/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });

    const ready = await requestJson(runtime.port, '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true });
  });

  it('returns 503 when bus check fails', async () => {
    const config = buildConfig();
    const fhirRepository = createFhirRepository();

    runtime = await startTriageRuntime({
      config,
      fhirRepository,
      queueNotifier,
      ingressIdempotencyStore: ingressStore,
      bus: createBus(),
      readinessCacheMs: 50,
      busHealthCheck: () => ({ ok: false, reason: 'bus_disconnected' }),
      port: 0,
    });

    const readyDown = await requestJson(runtime.port, '/readyz');
    expect(readyDown.status).toBe(503);
    expect(readyDown.body).toEqual({ ok: false, reason: 'bus_disconnected' });

    await runtime.stop();

    runtime = await startTriageRuntime({
      config,
      fhirRepository,
      queueNotifier,
      ingressIdempotencyStore: ingressStore,
      bus: createBus(),
      readinessCacheMs: 50,
      busHealthCheck: () => ({ ok: true }),
      port: 0,
    });

    const readyUp = await requestJson(runtime.port, '/readyz');
    expect(readyUp.status).toBe(200);
    expect(readyUp.body).toEqual({ ok: true });
  });

  it('returns 503 when backlog exceeds threshold', async () => {
    const config = buildConfig();
    const fhirRepository = createFhirRepository();
    runtime = await startTriageRuntime({
      config,
      fhirRepository,
      queueNotifier,
      ingressIdempotencyStore: ingressStore,
      bus: createBus(),
      readinessCacheMs: 50,
      maxPendingTasksReadyThreshold: 1,
      port: 0,
    });

    runtime.scheduler.track({
      taskId: 'task-1',
      patientId: 'patient-1',
      priority: 'ROUTINE',
      createdAt: new Date().toISOString(),
    });
    runtime.scheduler.track({
      taskId: 'task-2',
      patientId: 'patient-2',
      priority: 'ROUTINE',
      createdAt: new Date().toISOString(),
    });

    const ready = await requestJson(runtime.port, '/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ok: false, reason: 'backlog_high' });
  });

  it('returns 503 when custom readiness check fails', async () => {
    const config = buildConfig();
    const fhirRepository = createFhirRepository();
    runtime = await startTriageRuntime({
      config,
      fhirRepository,
      queueNotifier,
      ingressIdempotencyStore: ingressStore,
      bus: createBus(),
      readinessCacheMs: 50,
      extraReadinessChecks: [() => ({ ok: false, reason: 'store_unavailable' })],
      port: 0,
    });

    const ready = await requestJson(runtime.port, '/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ok: false, reason: 'store_unavailable' });
  });
});
