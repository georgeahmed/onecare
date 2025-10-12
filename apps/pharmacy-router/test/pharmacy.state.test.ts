import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ClassifiedState,
  EligibleState,
  IneligibleState,
  ReferredState,
  OutcomeRecordedState,
  type PharmacyContext,
  type PharmacyEvent,
} from '../src/application/pharmacy.state';
import type { PharmacyEligibilityRuleset, ResolvedConfig } from '@onecare/config';
import type { CpcsClient, CpcsServiceRequest, ReferralResult } from '../src/adapters/cpcs.client';
import type { FhirRepository } from '@onecare/ports';
import type { PatientNotifier } from '../src/application/pharmacy.state';
import { logger } from '@onecare/observability';

const baseEvent: PharmacyEvent = { type: 'pharmacy.route' };

const ruleset: PharmacyEligibilityRuleset = {
  defaultRule: {
    age: { min: 16, max: 80 },
    sex: ['female', 'male'],
    severity: { allowed: ['mild', 'moderate'], blocked: ['severe'] },
    exclusions: ['pregnant'],
  },
  conditions: {
    uti: {
      age: { min: 18 },
      sex: ['female'],
      exclusions: ['catheter'],
    },
  },
};

const defaultServiceRequest: CpcsServiceRequest = {
  id: 'sr-123',
  patientReference: 'patient-1',
  presentingComplaintCode: 'S76',
  consentTimestamp: '2025-01-01T00:00:00Z',
};
const defaultSummary = 'Referral summary';

function createFhirRepo(overrides: Partial<FhirRepository> = {}): FhirRepository {
  return {
    upsertBundle: vi.fn(async (bundle) => bundle),
    createTask: vi.fn(async () => ({ id: 'task-1', resourceType: 'Task' })),
    createAppointment: vi.fn(async () => ({ id: 'appt-1', resourceType: 'Appointment' })),
    createDocumentReference: vi.fn(async () => ({ id: 'doc-1', resourceType: 'DocumentReference' })),
    ...overrides,
  };
}

function buildContext(overrides: Partial<PharmacyContext> = {}): PharmacyContext {
  const cpcsClient: CpcsClient =
    overrides.cpcsClient ??
    ({
      sendReferral: vi.fn(async () => {
        return { status: 'accepted', reference: 'cpcs-ref' } as ReferralResult;
      }),
    } as unknown as CpcsClient);

  const fhirRepository: FhirRepository =
    overrides.fhirRepository ?? createFhirRepo();

  const notifier =
    overrides.notifier ??
    ({
      notifyReferral: vi.fn(async () => {}),
    } as PatientNotifier);

  const hasServiceRequestOverride = Object.prototype.hasOwnProperty.call(overrides, 'serviceRequest');
  const hasSummaryOverride = Object.prototype.hasOwnProperty.call(overrides, 'referralSummary');

  const context: PharmacyContext = {
    id: 'ctx-1',
    document: { conditionCode: 'UTI', severity: 'mild' },
    patient: { ageYears: 25, sex: 'female' },
    ruleset,
    cpcsClient,
    fhirRepository,
    notifier,
    referralOrgId: 'ORG1',
    correlationId: 'corr-1',
    ...overrides,
  };

  if (!hasServiceRequestOverride) {
    context.serviceRequest = context.serviceRequest ?? { ...defaultServiceRequest };
  }
  if (!hasSummaryOverride) {
    context.referralSummary = context.referralSummary ?? defaultSummary;
  }

  return context;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ClassifiedState', () => {
  it('marks context as eligible when rules pass', async () => {
    const state = new ClassifiedState();
    const ctx = buildContext({ serviceRequest: undefined, referralSummary: undefined });
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Eligible');
    expect(ctx.eligibilityDecision).toEqual({ ok: true, reason: 'eligible' });
    expect(ctx.eligibilityRule?.age?.min).toBe(18);
    expect(ctx.serviceRequest?.id).toMatch(/^sr-/);
    expect(ctx.referralSummary).toMatch(/Pharmacy First referral/);
    const logCall = infoSpy.mock.calls.find(([msg]) => msg === 'pharmacy.eligibility.decision');
    expect(logCall?.[1]).toMatchObject({
      eligible: true,
      eligibilityReason: 'eligible',
      hasPatientAgeYears: true,
      hasPatientSex: true,
    });
    expect(logCall?.[1]).not.toHaveProperty('condition');
    expect(logCall?.[1]?.conditionFingerprint).toEqual(expect.any(String));
  });

  it('uses injected ruleset when provided', async () => {
    const state = new ClassifiedState(ruleset);
    const ctx = buildContext({ ruleset: undefined });
    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Eligible');
    expect(ctx.eligibilityDecision?.ok).toBe(true);
  });

  it('falls back to config rules when available', async () => {
    const config = { practiceId: 'demo', pharmacy: { eligibility: ruleset } } as unknown as ResolvedConfig;
    const state = new ClassifiedState();
    const ctx = buildContext({ ruleset: undefined, config });
    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Eligible');
    expect(ctx.eligibilityDecision?.ok).toBe(true);
  });

  it('returns Ineligible when rules fail and records reason', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const state = new ClassifiedState();
    const ctx = buildContext({
      patient: { ageYears: 10, sex: 'female' },
    });
    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('Ineligible');
    expect(ctx.eligibilityDecision).toEqual({ ok: false, reason: 'age_below_min' });
    const logCall = warnSpy.mock.calls.find(([msg]) => msg === 'pharmacy.eligibility.decision');
    expect(logCall?.[1]).toMatchObject({
      eligible: false,
      eligibilityReason: 'age_below_min',
      hasPatientAgeYears: true,
    });
    expect(logCall?.[1]).not.toHaveProperty('condition');
  });

  it('throws when document missing', async () => {
    const state = new ClassifiedState();
    const ctx = buildContext({ document: undefined });
    await expect(state.handle(ctx, baseEvent)).rejects.toThrow('document_missing');
  });
});

describe('EligibleState', () => {
  it('moves to referred when eligibility confirmed', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const state = new EligibleState();
    const ctx = buildContext({ eligibilityDecision: { ok: true, reason: 'eligible' } });
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('Referred');
    const logCall = infoSpy.mock.calls.find(([msg]) => msg === 'pharmacy.referral.ready');
    expect(logCall?.[1]).toMatchObject({
      eligibilityReason: 'eligible',
      conditionFingerprint: expect.any(String),
    });
    expect(logCall?.[1]).not.toHaveProperty('condition');
  });

  it('throws if eligibility not confirmed', async () => {
    const state = new EligibleState();
    const ctx = buildContext({ eligibilityDecision: { ok: false, reason: 'rule_missing' } });
    await expect(state.handle(ctx, baseEvent)).rejects.toThrow('eligibility_not_confirmed');
  });
});

describe('IneligibleState', () => {
  it('is terminal for ineligible flow', async () => {
    const state = new IneligibleState();
    const ctx = buildContext();
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('Ineligible');
  });

  it('creates escalation task when severity blocked', async () => {
    const state = new IneligibleState();
    const ctx = buildContext({
      eligibilityDecision: { ok: false, reason: 'severity_blocked' },
    });
    await state.handle(ctx, baseEvent);
    expect((ctx.fhirRepository as FhirRepository).createTask).toHaveBeenCalled();
  });
});

describe('ReferredState', () => {
  it('sends referral through cpcs client and logs outcome', async () => {
    const sendReferral = vi.fn(async () => ({ status: 'accepted', reference: 'ref' }));
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const state = new ReferredState();
    const ctx = buildContext({
      cpcsClient: { sendReferral } as unknown as CpcsClient,
      eligibilityDecision: { ok: true, reason: 'eligible' },
    });

    const next = await state.handle(ctx, baseEvent);

    expect(next).toBe('OutcomeRecorded');
    expect(sendReferral).toHaveBeenCalledWith(
      'ORG1',
      ctx.serviceRequest,
      ctx.referralSummary,
      undefined,
      expect.objectContaining({ correlationId: 'corr-1' }),
    );
    expect(ctx.referralResult).toEqual({ status: 'accepted', reference: 'ref' });
    const logCall = infoSpy.mock.calls.find(([msg]) => msg === 'pharmacy.referral.sent');
    expect(logCall?.[1]).toMatchObject({
      eligibilityReason: 'eligible',
      organisationFingerprint: expect.any(String),
      hasServiceRequest: true,
      status: 'accepted',
    });
    expect(logCall?.[1]).not.toHaveProperty('serviceRequestId');
    expect((ctx.notifier as PatientNotifier).notifyReferral).toHaveBeenCalledWith(
      expect.objectContaining({ serviceRequestId: ctx.serviceRequest?.id, status: 'accepted' }),
    );
  });

  it('captures errors and logs failure', async () => {
    const error = new Error('network');
    const sendReferral = vi.fn(async () => {
      throw error;
    });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const state = new ReferredState();
    const ctx = buildContext({
      cpcsClient: { sendReferral } as unknown as CpcsClient,
      eligibilityDecision: { ok: true, reason: 'eligible' },
    });

    await expect(state.handle(ctx, baseEvent)).rejects.toThrow('network');
    expect(ctx.referralError).toBe(error);
    const logCall = errorSpy.mock.calls.find(([msg]) => msg === 'pharmacy.referral.failed');
    expect(logCall?.[1]).toMatchObject({
      eligibilityReason: 'eligible',
      organisationFingerprint: expect.any(String),
      hasServiceRequest: true,
    });
    expect((ctx.notifier as PatientNotifier).notifyReferral).not.toHaveBeenCalled();
  });
});

describe('OutcomeRecordedState', () => {
  it('logs final outcome with eligibility reason', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const state = new OutcomeRecordedState();
    const ctx = buildContext({
      eligibilityDecision: { ok: true, reason: 'eligible' },
      referralResult: { status: 'queued', reference: 'ref' },
    });
    const next = await state.handle(ctx, baseEvent);
    expect(next).toBe('OutcomeRecorded');
    const logCall = infoSpy.mock.calls.find(([msg]) => msg === 'pharmacy.outcome.recorded');
    expect(logCall?.[1]).toMatchObject({
      eligibilityReason: 'eligible',
      referralStatus: 'queued',
      hasServiceRequest: true,
    });
    expect(logCall?.[1]).not.toHaveProperty('serviceRequestId');
    const repo = ctx.fhirRepository as FhirRepository;
    expect(repo.upsertBundle).toHaveBeenCalled();
    expect(repo.createTask).not.toHaveBeenCalled();
    expect(ctx.outcomeBundle).toBeDefined();
  });

  it('creates escalation task when referral rejected', async () => {
    const state = new OutcomeRecordedState();
    const ctx = buildContext({
      referralResult: { status: 'rejected', reference: 'ref', code: 'slot_unavailable' },
      eligibilityDecision: { ok: true, reason: 'eligible' },
    });
    await state.handle(ctx, baseEvent);
    expect((ctx.fhirRepository as FhirRepository).createTask).toHaveBeenCalled();
  });
});
