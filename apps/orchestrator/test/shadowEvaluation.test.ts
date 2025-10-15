import { describe, expect, it, vi } from 'vitest';
import type { ShadowSafetyGateContext } from '../src/types';
import { maybeRunShadowEvaluation, runShadowEvaluation } from '../src/application/shadowEvaluation';
import type { OrchestratorContext } from '../src/types';
import type { PortalSubmission } from '@onecare/events';

function buildSubmission(): PortalSubmission {
  return {
    practiceId: 'demo',
    patient: { id: 'patient-1' },
    narrative: 'Patient reports mild headache.',
    channel: 'web',
  };
}

function createContext(shadow: ShadowSafetyGateContext) {
  const analyzeSubmission = vi.fn().mockResolvedValue({ outcome: 'DIVERTED', reason: 'shadow-hit' });
  const callGuard = vi.fn().mockImplementation(async (_name, fn: (signal: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
  );
  const recordAudit = vi.fn();
  const emitAudit = vi.fn().mockResolvedValue(undefined);

  const ctx: OrchestratorContext = {
    correlationId: 'corr-1',
    requestId: 'req-1',
    submission: buildSubmission(),
    practiceId: 'demo',
    authHeader: undefined,
    authContext: null,
    actor: { id: 'actor-1', type: 'patient' },
    scope: ['safety:analyze'],
    replayFingerprint: 'fp-1',
    security: {
      verifySignatureAndReplayGuard: vi.fn().mockResolvedValue(true),
      authorize: vi.fn().mockResolvedValue(true),
      checkConsent: vi.fn().mockResolvedValue(true),
    },
    consentPurpose: 'care',
    consentResources: ['QuestionnaireResponse'],
    consentEvidence: { reference: 'consent-ref-1' },
    resolveConsentEvidence: () => ({ reference: 'consent-ref-1' }),
    setOutcome: vi.fn(),
    safetyGateOptions: {},
    callGuard: callGuard as OrchestratorContext['callGuard'],
    analyzeSubmission: analyzeSubmission as OrchestratorContext['analyzeSubmission'],
    safetyGuardOptions: { timeoutMs: 800, maxRetries: 1, baseDelayMs: 10, correlationId: 'corr-1' },
    safetyFallbackMode: 'rules',
    decision: { outcome: 'SAFE_TO_CONTINUE', reason: 'safe' },
    idempotencyStore: {} as OrchestratorContext['idempotencyStore'],
    idempotencyKey: 'idem-1',
    idempotencyTtlSeconds: 600,
    idempotencyReserved: false,
    recordIdempotencyHit: vi.fn(),
    recordIdempotencyMiss: vi.fn(),
    recordIdempotencyTtl: vi.fn(),
    fhirRepository: {} as OrchestratorContext['fhirRepository'],
    fhirBundle: undefined,
    mapFhirError: vi.fn(),
    bus: {} as OrchestratorContext['bus'],
    triageTopic: 'triage.input',
    busHeaders: undefined,
    emitAudit: emitAudit as OrchestratorContext['emitAudit'],
    recordAudit: recordAudit as OrchestratorContext['recordAudit'],
    result: undefined,
    classifyErrorCode: () => undefined,
    shadowSafetyGate: shadow,
  };

  return {
    ctx,
    analyzeSubmission,
    callGuard,
    recordAudit,
    emitAudit,
  };
}

function makeShadow(overrides?: Partial<ShadowSafetyGateContext>): ShadowSafetyGateContext {
  return {
    enabled: true,
    sampleRate: 1,
    endpoint: 'https://shadow.example/analyze',
    variant: 'next',
    timeoutMs: 420,
    maxRetries: 0,
    baseDelayMs: 5,
    auditEvent: 'orchestrator.safety.shadow',
    random: () => 0,
    ...(overrides ?? {}),
  };
}

describe('shadow evaluation helpers', () => {
  it('records audit and emits when shadow evaluation succeeds', async () => {
    const shadow = makeShadow();
    const { ctx, callGuard, recordAudit, emitAudit } = createContext(shadow);

    await runShadowEvaluation(ctx, shadow);

    expect(callGuard).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      'orchestrator.safety.shadow',
      expect.objectContaining({
        shadowOutcome: 'DIVERTED',
        primaryOutcome: 'SAFE_TO_CONTINUE',
      }),
    );
    expect(emitAudit).toHaveBeenCalledWith(
      'orchestrator.safety.shadow',
      expect.objectContaining({ shadowOutcome: 'DIVERTED' }),
    );
});

  it('swallows errors from the guarded shadow call', async () => {
    const shadow = makeShadow();
    const { ctx, callGuard, recordAudit, emitAudit } = createContext(shadow);
    callGuard.mockImplementation(async () => {
      throw new Error('shadow-failure');
    });

    await expect(runShadowEvaluation(ctx, shadow)).resolves.toBeUndefined();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(emitAudit).not.toHaveBeenCalled();
  });

  it('samples shadow evaluation based on configured rate', async () => {
    const shadow = makeShadow({ sampleRate: 0.1, random: () => 0.9 });
    const { ctx, callGuard } = createContext(shadow);

    maybeRunShadowEvaluation(ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(callGuard).not.toHaveBeenCalled();
  });
});
