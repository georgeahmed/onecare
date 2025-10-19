import { describe, it, expect, beforeEach, vi } from 'vitest';
import { publishWithRetry } from '../../apps/orchestrator/src/adapters/busUtil';
import type { MessageBus } from '../../packages/bus/src/types';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import { Topics } from '../../packages/events/src/topics';
import { createHttpFhirRepository, FhirRequestError, isFhirRequestError } from '../../apps/orchestrator/src/adapters/persistence/fhir.repository';

const delayCalls: number[] = [];

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => {
    delayCalls.push(ms);
    return Promise.resolve();
  },
}));

class PoisonBus implements MessageBus {
  public attempts = 0;

  async publish(): Promise<void> {
    this.attempts += 1;
    throw Object.assign(new Error('bus_down'), { code: 'econnrefused' });
  }

  async subscribe(): Promise<{ unsubscribe(): Promise<void> }> {
    return { unsubscribe: async () => {} };
  }
}

describe('Chaos drills', () => {
  beforeEach(() => {
    delayCalls.length = 0;
  });

  it('guardrails bus outage with bounded retries', async () => {
    const bus = new PoisonBus();
    const envelope = createEnvelope('triage.input', { patientId: 'patient-chaos', narrative: 'load shedding' }, 'corr-chaos');

    await expect(
      publishWithRetry({
        bus,
        envelope,
        correlationId: 'corr-chaos',
        timeoutMs: 0,
        maxAttempts: 3,
        payloadRef: 'triage:submission:chaos',
        baseDelayMs: 20,
      }),
    ).rejects.toMatchObject({ code: 'bus_down' });

    expect(bus.attempts).toBe(3);
    expect(delayCalls).toHaveLength(2);
    const totalDelayBudget = delayCalls.reduce((acc, value) => acc + value, 0);
    expect(totalDelayBudget).toBeLessThanOrEqual(80);
  });

  it('opens the FHIR circuit after sustained 5xx responses', async () => {
    const fetchCalls: number[] = [];
    const fetchImpl = vi.fn(async () => {
      fetchCalls.push(Date.now());
      return new globalThis.Response(JSON.stringify({ resourceType: 'OperationOutcome' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'content-type': 'application/fhir+json; charset=utf-8' },
      });
    });

    const repo = createHttpFhirRepository({
      baseUrl: 'https://mock-fhir.example/fhir',
      fetchImpl,
      maxRetries: 0,
      circuitBreakerThreshold: 1,
      circuitBreakerCooldownMs: 60_000,
    });

    await expect(repo.readResource('Task/task-chaos')).rejects.toMatchObject({ status: 503 });
    expect(fetchCalls).toHaveLength(1);

    const circuitError = await repo.readResource('Task/task-chaos').catch((error) => error as Error);
    expect(circuitError).toBeInstanceOf(FhirRequestError);
    expect(circuitError.message).toBe('circuit_open');
    expect(fetchCalls).toHaveLength(1);
    expect(isFhirRequestError(circuitError) ? circuitError.retryable : false).toBe(false);
  });
});
