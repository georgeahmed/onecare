import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedConfig } from '@onecare/config';
import type { CpcsClient, ReferralResult } from '../src/adapters/cpcs.client';
import { runPharmacyReferral, createPharmacyRouterMachine } from '../src/application/router';
import { handlePharmacyReferral } from '../src/index';
import type { PharmacyContext } from '../src/application/pharmacy.state';
import type { FhirRepository } from '@onecare/ports';
import type { PatientNotifier } from '../src/application/pharmacy.state';

const config = {
  practiceId: 'demo',
  pharmacy: {
    eligibility: {
      defaultRule: {
        age: { min: 16 },
        sex: ['female', 'male'],
      },
      conditions: {
        uti: {
          sex: ['female'],
        },
      },
    },
  },
} as unknown as ResolvedConfig;

function createFhirRepo(overrides: Partial<FhirRepository> = {}): FhirRepository {
  return {
    upsertBundle: vi.fn(async (bundle) => bundle),
    createTask: vi.fn(async () => ({ id: 'task-1', resourceType: 'Task' })),
    createAppointment: vi.fn(async () => ({ id: 'appt-1', resourceType: 'Appointment' })),
    createDocumentReference: vi.fn(async () => ({ id: 'doc-1', resourceType: 'DocumentReference' })),
    ...overrides,
  };
}

function createNotifier(): PatientNotifier {
  return {
    notifyReferral: vi.fn(async () => {}),
  };
}

function createContext(overrides: Partial<PharmacyContext> = {}): PharmacyContext {
  const cpcsClient: CpcsClient =
    overrides.cpcsClient ??
    ({
      sendReferral: vi.fn(async () => ({ status: 'accepted', reference: 'ref' } as ReferralResult)),
    } as unknown as CpcsClient);

  const fhirRepository = overrides.fhirRepository ?? createFhirRepo();
  const notifier = overrides.notifier ?? createNotifier();

  return {
    id: 'ctx-test',
    document: { conditionCode: 'UTI', severity: 'mild' },
    patient: { ageYears: 30, sex: 'female' },
    config,
    cpcsClient,
    fhirRepository,
    notifier,
    serviceRequest: overrides.serviceRequest ?? undefined,
    referralSummary: overrides.referralSummary ?? undefined,
    referralOrgId: 'ORG1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runPharmacyReferral', () => {
  it('processes eligible referral through to outcome', async () => {
    const sendReferral = vi.fn(async () => ({ status: 'accepted', reference: 'ref' }));
    const context = createContext({ cpcsClient: { sendReferral } as unknown as CpcsClient });

    const result = await runPharmacyReferral(context);

    expect(result.state).toBe('OutcomeRecorded');
    expect(context.eligibilityDecision?.ok).toBe(true);
    expect(context.referralResult).toEqual({ status: 'accepted', reference: 'ref' });
    expect(sendReferral).toHaveBeenCalledTimes(1);
    expect(context.serviceRequest).toBeDefined();
    expect(context.referralSummary).toBeDefined();
    expect((context.fhirRepository as FhirRepository).upsertBundle).toHaveBeenCalled();
  });

  it('stops at ineligible state without calling referral', async () => {
    const sendReferral = vi.fn();
    const context = createContext({
      patient: { ageYears: 10, sex: 'female' },
      cpcsClient: { sendReferral } as unknown as CpcsClient,
    });

    const result = await runPharmacyReferral(context);

    expect(result.state).toBe('Ineligible');
    expect(context.eligibilityDecision?.ok).toBe(false);
    expect(sendReferral).not.toHaveBeenCalled();
  });
});

describe('createPharmacyRouterMachine', () => {
  it('creates machine with provided config or rules', () => {
    const context = createContext({ ruleset: undefined });
    const machine = createPharmacyRouterMachine(context);
    expect(machine).toBeDefined();
  });
});

describe('handlePharmacyReferral', () => {
  it('builds context and runs referral flow', async () => {
    const sendReferral = vi.fn(async () => ({ status: 'accepted', reference: 'ref' }));
    const fhirRepository = createFhirRepo();
    const notifier = createNotifier();
    const result = await handlePharmacyReferral(
      {
        document: { conditionCode: 'UTI', severity: 'mild' },
        patient: { ageYears: 28, sex: 'female' },
        organisationId: 'ORG1',
        correlationId: 'corr-2',
      },
      {
        cpcsClient: { sendReferral } as unknown as CpcsClient,
        config,
        fhirRepository,
        notifier,
      },
    );

    expect(result.state).toBe('OutcomeRecorded');
    expect(result.context.eligibilityDecision?.ok).toBe(true);
    expect(sendReferral).toHaveBeenCalledTimes(1);
    expect(fhirRepository.upsertBundle).toHaveBeenCalled();
    expect(notifier.notifyReferral).toHaveBeenCalled();
    expect(result.context.serviceRequest).toBeDefined();
  });
});
