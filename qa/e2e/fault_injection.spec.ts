import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const delayCalls: number[] = [];

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => {
    delayCalls.push(ms);
    return Promise.resolve();
  },
}));

import { callWithGuard, resetGuardBreakers } from '../../apps/orchestrator/src/adapters/services/callWithGuard';
import { publishWithRetry } from '../../apps/orchestrator/src/adapters/busUtil';
import { SafetyEvaluatedState } from '../../apps/orchestrator/src/application/orchestrator.state';
import { InMemoryIdempotencyStore, reserveIdempotency } from '../../apps/orchestrator/src/application/idempotency';
import type { OrchestratorContext } from '../../apps/orchestrator/src/types';
import { MemoryBus } from '../../packages/bus/src/memoryBus';
import type { MessageBus } from '../../packages/bus/src/types';
import { createEnvelope } from '../../packages/events/src/envelope-util';
import { Topics } from '../../packages/events/src/topics';
import type { PortalSubmission } from '../../packages/events/src/contracts/ingest';
import type { TriageInput } from '../../packages/events/src/contracts/triage';

class FlakyBus implements MessageBus {
  public readonly publishes: { topic: string; payload: unknown; headers?: Record<string, string> }[] = [];
  private attempt = 0;

  constructor(private readonly failuresBeforeSuccess: number, private readonly failWith: Error) {}

  async publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void> {
    if (topic === Topics.triage.input) {
      this.attempt += 1;
      if (this.attempt <= this.failuresBeforeSuccess) {
        throw this.failWith;
      }
    }
    this.publishes.push({ topic, payload, headers });
  }

  async subscribe(): Promise<{ unsubscribe(): Promise<void> }> {
    return { unsubscribe: async () => {} };
  }

  get attempts(): number {
    return this.attempt;
  }
}

describe('Fault injection resilience', () => {
  beforeEach(() => {
    delayCalls.length = 0;
    resetGuardBreakers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries transient safety gate timeouts with bounded jitter', async () => {
    const attempts: number[] = [];
    const guardFn = vi.fn<Parameters<Parameters<typeof callWithGuard>[1]>, ReturnType<Parameters<typeof callWithGuard>[1]>>(
      (signal) =>
        new Promise((_, reject) => {
          attempts.push(Date.now());
          signal.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('upstream_timeout'), { code: 'upstream_timeout' }));
            },
            { once: true },
          );
          setTimeout(() => {
            if (!signal.aborted) {
              reject(Object.assign(new Error('slow_response'), { code: 'temporarily_unavailable' }));
            }
          }, 50);
        }),
    );

    const sleepDurations: number[] = [];
    await expect(
      callWithGuard('safety_gate', guardFn, {
        timeoutMs: 5,
        maxRetries: 2,
        baseDelayMs: 25,
        random: () => 0,
        sleep: async (ms) => {
          sleepDurations.push(ms);
        },
      }),
    ).rejects.toMatchObject({ code: 'upstream_timeout' });

    expect(guardFn).toHaveBeenCalledTimes(3);
    expect(sleepDurations).toEqual([25, 50]);
  });

  it('opens the circuit breaker after persistent upstream failures', async () => {
    const failingError = Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
    const guardFn = vi.fn().mockRejectedValue(failingError);
    const options = { timeoutMs: 10, maxRetries: 0, cbFailureThreshold: 3, cbCooldownMs: 60_000 };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(callWithGuard('gp-connect', guardFn, options)).rejects.toBe(failingError);
    }

    const freshCall = vi.fn();
    await expect(callWithGuard('gp-connect', freshCall, options)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(freshCall).not.toHaveBeenCalled();
  });

  it('falls back to safety rules when the guard circuit is open', async () => {
    const state = new SafetyEvaluatedState();
    const submission: PortalSubmission = {
      practiceId: 'demo',
      patient: { id: 'patient-123' },
      narrative: 'severe cough',
      channel: 'web',
    };
    const consentEvidence = { reference: 'consent-1', purpose: 'triage', resources: ['triage'] };
    const recordAudit = vi.fn();
    const emitAudit = vi.fn().mockResolvedValue(undefined);
    const classifyErrorCode = vi.fn().mockReturnValue('circuit_open');
    const context: OrchestratorContext = {
      correlationId: 'corr-fallback',
      requestId: 'req-1',
      submission,
      practiceId: 'demo',
      authHeader: undefined,
      authContext: { actor: { type: 'practitioner', id: 'clin-1' } },
      actor: { type: 'practitioner', id: 'clin-1' },
      scope: ['triage:submit'],
      replayFingerprint: 'fp-1',
      security: {
        verifySignatureAndReplayGuard: async () => true,
        authorize: async () => true,
        checkConsent: async () => ({ allowed: true, reason: 'granted', evidence: consentEvidence }),
      },
      consentPurpose: 'triage',
      consentResources: ['triage'],
      consentEvidence,
      resolveConsentEvidence: () => consentEvidence,
      setOutcome: vi.fn(),
      safetyGateOptions: {},
      callGuard: vi.fn().mockRejectedValue(Object.assign(new Error('circuit_open'), { code: 'circuit_open' })),
      analyzeSubmission: vi.fn(),
      safetyGuardOptions: {},
      safetyFallbackMode: 'rules',
      decision: undefined,
      shadowSafetyGate: undefined,
      idempotencyStore: new InMemoryIdempotencyStore(),
      idempotencyKey: 'idem-key',
      idempotencyTtlSeconds: 60,
      idempotencyReserved: false,
      recordIdempotencyHit: vi.fn(),
      recordIdempotencyMiss: vi.fn(),
      recordIdempotencyTtl: vi.fn(),
      fhirRepository: {} as OrchestratorContext['fhirRepository'],
      fhirBundle: undefined,
      mapFhirError: () => ({ code: 'internal_error', message: 'unexpected' }),
      bus: new MemoryBus(),
      triageTopic: Topics.triage.input,
      busHeaders: undefined,
      busPublishOptions: { timeoutMs: 0, maxRetries: 0, baseDelayMs: 0 },
      emitAudit,
      recordAudit,
      result: undefined,
      classifyErrorCode,
    };

    const next = await state.handle(context);

    expect(next).toBe('Normalized');
    expect(context.decision).toEqual({ outcome: 'SAFE_TO_CONTINUE', reason: 'FALLBACK_RULES' });
    expect(recordAudit).toHaveBeenCalledWith(
      'orchestrator.safety.fallback',
      expect.objectContaining({ reasonCode: 'safety_fallback' }),
    );
    expect(emitAudit).toHaveBeenCalledTimes(1);
    expect(classifyErrorCode).toHaveBeenCalled();
  });

  it('guards idempotent publish operations against duplicate side effects', async () => {
    const store = new InMemoryIdempotencyStore();
    const key = 'portal::submission::1';
    const publish = vi.fn();

    async function processOnce(): Promise<'reserved' | 'duplicate'> {
      const status = await reserveIdempotency(store, key, { ttlSeconds: 120 });
      if (status === 'exists') {
        return 'duplicate';
      }
      await publish();
      return 'reserved';
    }

    await expect(processOnce()).resolves.toBe('reserved');
    await expect(processOnce()).resolves.toBe('duplicate');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('retries publish with exponential backoff and succeeds after transient failures', async () => {
    const error = Object.assign(new Error('temporarily_unavailable'), { code: 'temporarily_unavailable' });
    const bus = new FlakyBus(2, error);
    const triagePayload: TriageInput = {
      patientId: 'pat-1',
      narrative: 'needs triage',
    };
    const envelope = createEnvelope(Topics.triage.input, triagePayload, 'corr-publish');
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      await expect(
        publishWithRetry({
          bus,
          envelope,
          correlationId: 'corr-publish',
          timeoutMs: 0,
          maxAttempts: 3,
          baseDelayMs: 10,
          payloadRef: { submissionId: 'sub-1' },
        }),
      ).resolves.toBeUndefined();
    } finally {
      randomSpy.mockRestore();
    }

    expect(bus.attempts).toBe(3);
    expect(delayCalls).toEqual([10, 20]);
    expect(bus.publishes.filter((p) => p.topic === Topics.triage.input)).toHaveLength(1);
  });
});
