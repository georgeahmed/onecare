import { createHash } from 'node:crypto';
import { BaseState } from '@onecare/statekit';
import type { MachineContext, MachineEvent } from '@onecare/statekit';
import type {
  PharmacyEligibilityRuleset,
  PharmacyEligibilityRule,
  PharmacyPatientSex,
  ResolvedConfig,
} from '@onecare/config';
import { getPharmacyEligibilityRules } from '@onecare/config';
import { logger } from '@onecare/observability';
import {
  isEligible,
  type EligibilityDocument,
  type EligibilityPatient,
  type EligibilityDecision,
} from './eligibility';
import type {
  CpcsClient,
  CpcsServiceRequest,
  CpcsSlot,
  ReferralResult,
  ReferralOptions,
} from '../adapters/cpcs.client';
import type { FhirBundle, FhirRepository, FhirResourceRef } from '@onecare/ports';

export interface PharmacyContext extends MachineContext {
  document?: EligibilityDocument;
  patient?: EligibilityPatient;
  ruleset?: PharmacyEligibilityRuleset;
  config?: ResolvedConfig;
  correlationId?: string;
  cpcsClient?: CpcsClient;
  fhirRepository?: FhirRepository;
  notifier?: PatientNotifier;
  serviceRequest?: CpcsServiceRequest;
  referralSummary?: string;
  referralOrgId?: string;
  referralSlot?: CpcsSlot;
  referralOptions?: ReferralOptions;
  referralResult?: ReferralResult;
  referralError?: unknown;
  escalationTaskRef?: FhirResourceRef;
  outcomeBundle?: FhirBundle;
  eligibilityDecision?: EligibilityDecision;
  eligibilityRule?: PharmacyEligibilityRule;
}

export interface PharmacyEvent extends MachineEvent {
  type: 'pharmacy.route' | string;
}

export class ClassifiedState extends BaseState<PharmacyContext, PharmacyEvent> {
  constructor(private readonly injectedRules?: PharmacyEligibilityRuleset) {
    super('Classified');
  }

  static fromConfig(config: ResolvedConfig): ClassifiedState {
    return new ClassifiedState(getPharmacyEligibilityRules(config));
  }

  async handle(ctx: PharmacyContext, _event: PharmacyEvent): Promise<string> {
    if (!ctx.document || !ctx.document.conditionCode) {
      throw new Error('document_missing');
    }
    if (!ctx.patient) {
      throw new Error('patient_missing');
    }

    const rules =
      this.injectedRules ??
      ctx.ruleset ??
      (ctx.config ? getPharmacyEligibilityRules(ctx.config) : undefined);

    const decision = isEligible(ctx.document, ctx.patient, rules);
    const decisionWithReason: EligibilityDecision = decision.ok
      ? { ...decision, reason: decision.reason ?? 'eligible' }
      : decision;
    ctx.eligibilityDecision = decisionWithReason;
    ctx.eligibilityRule = resolveRuleForCondition(ctx.document.conditionCode, rules);
    if (decisionWithReason.ok) {
      ctx.serviceRequest = ctx.serviceRequest ?? buildServiceRequest(ctx);
      ctx.referralSummary = ctx.referralSummary ?? buildReferralSummary(ctx);
    }

    const logFields = {
      ctxId: ctx.id,
      correlationId: ctx.correlationId,
      conditionFingerprint: fingerprint(ctx.document.conditionCode),
      eligible: decisionWithReason.ok,
      eligibilityReason: decisionWithReason.reason ?? 'unknown',
      hasPatientAgeYears: isFiniteNumber(ctx.patient.ageYears),
      hasPatientSex: Boolean(ctx.patient.sex && ctx.patient.sex !== 'unknown'),
    };

    if (decisionWithReason.ok) {
      logger.info('pharmacy.eligibility.decision', logFields);
      return 'Eligible';
    }

    logger.warn('pharmacy.eligibility.decision', logFields);
    if (!decision.ok) {
      return 'Ineligible';
    }
    return 'Eligible';
  }
}

export class EligibleState extends BaseState<PharmacyContext, PharmacyEvent> {
  constructor() {
    super('Eligible');
  }

  async handle(ctx: PharmacyContext, _event: PharmacyEvent): Promise<string> {
    if (!ctx.eligibilityDecision?.ok) {
      throw new Error('eligibility_not_confirmed');
    }
    logger.info('pharmacy.referral.ready', {
      ctxId: ctx.id,
      correlationId: ctx.correlationId,
      conditionFingerprint: fingerprint(ctx.document?.conditionCode),
      eligibilityReason: ctx.eligibilityDecision.reason ?? 'eligible',
    });
    return 'Referred';
  }
}

export class IneligibleState extends BaseState<PharmacyContext, PharmacyEvent> {
  constructor() {
    super('Ineligible');
  }

  async handle(ctx: PharmacyContext, _event: PharmacyEvent): Promise<string> {
    if (shouldEscalateIneligibility(ctx) && ctx.fhirRepository) {
      ctx.escalationTaskRef = await ctx.fhirRepository.createTask(
        buildEscalationTask(ctx, 'eligibility_denied'),
      );
    }
    return 'Ineligible';
  }
}

export class ReferredState extends BaseState<PharmacyContext, PharmacyEvent> {
  constructor() {
    super('Referred');
  }

  async handle(ctx: PharmacyContext, _event: PharmacyEvent): Promise<string> {
    if (!ctx.cpcsClient) {
      throw new Error('cpcs_client_missing');
    }
    if (!ctx.referralOrgId) {
      throw new Error('referral_org_missing');
    }
    if (!ctx.serviceRequest) {
      throw new Error('service_request_missing');
    }
    if (!ctx.referralSummary || ctx.referralSummary.trim().length === 0) {
      throw new Error('referral_summary_missing');
    }

    const options: ReferralOptions = {
      ...ctx.referralOptions,
      correlationId: ctx.referralOptions?.correlationId ?? ctx.correlationId,
    };

    try {
      const result = await ctx.cpcsClient.sendReferral(
        ctx.referralOrgId,
        ctx.serviceRequest,
        ctx.referralSummary,
        ctx.referralSlot,
        options,
      );
      ctx.referralResult = result;
      await notifyPatient(ctx);
      logger.info('pharmacy.referral.sent', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        organisationFingerprint: fingerprint(ctx.referralOrgId),
        hasServiceRequest: Boolean(ctx.serviceRequest?.id),
        status: result.status,
        eligibilityReason: ctx.eligibilityDecision?.reason ?? 'eligible',
      });
    } catch (error) {
      ctx.referralError = error;
      logger.error('pharmacy.referral.failed', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        organisationFingerprint: fingerprint(ctx.referralOrgId),
        hasServiceRequest: Boolean(ctx.serviceRequest?.id),
        eligibilityReason: ctx.eligibilityDecision?.reason ?? 'eligible',
        error:
          error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : 'unknown_error',
      });
      throw error;
    }

    return 'OutcomeRecorded';
  }
}

export class OutcomeRecordedState extends BaseState<PharmacyContext, PharmacyEvent> {
  constructor() {
    super('OutcomeRecorded');
  }

  async handle(ctx: PharmacyContext, _event: PharmacyEvent): Promise<string> {
    if (!ctx.fhirRepository) {
      throw new Error('fhir_repository_missing');
    }
    logger.info('pharmacy.outcome.recorded', {
      ctxId: ctx.id,
      correlationId: ctx.correlationId,
      hasServiceRequest: Boolean(ctx.serviceRequest?.id),
      referralStatus: ctx.referralResult?.status ?? 'none',
      eligibilityReason: ctx.eligibilityDecision?.reason ?? 'eligible',
    });
    const bundle = buildOutcomeBundle(ctx);
    ctx.outcomeBundle = await ctx.fhirRepository.upsertBundle(bundle);

    if (shouldEscalateAfterReferral(ctx)) {
      ctx.escalationTaskRef = await ctx.fhirRepository.createTask(
        buildEscalationTask(ctx, 'referral_failed'),
      );
    }
    return 'OutcomeRecorded';
  }
}

function resolveRuleForCondition(
  condition: string,
  ruleset: PharmacyEligibilityRuleset | undefined,
): PharmacyEligibilityRule | undefined {
  if (!ruleset) return undefined;
  const normalised = condition.trim().toLowerCase();
  const conditionRule = ruleset.conditions?.[normalised];
  if (!conditionRule && !ruleset.defaultRule) return undefined;
  return mergeRules(ruleset.defaultRule, conditionRule);
}

function mergeRules(
  base: PharmacyEligibilityRule | undefined,
  override: PharmacyEligibilityRule | undefined,
): PharmacyEligibilityRule | undefined {
  if (!base && !override) return undefined;
  const merged: PharmacyEligibilityRule = {};
  if (base?.age) merged.age = { ...base.age };
  if (override?.age) merged.age = { ...(merged.age ?? {}), ...override.age };
  if (merged.age && merged.age.min === undefined && merged.age.max === undefined) {
    delete merged.age;
  }

  const sex: PharmacyPatientSex[] | undefined = override?.sex ?? base?.sex;
  if (sex && sex.length > 0) {
    merged.sex = [...sex];
  }

  if (base?.severity) {
    merged.severity = {
      allowed: base.severity.allowed ? [...base.severity.allowed] : undefined,
      blocked: base.severity.blocked ? [...base.severity.blocked] : undefined,
    };
  }
  if (override?.severity) {
    if (!merged.severity) merged.severity = {};
    if (override.severity.allowed) merged.severity.allowed = [...override.severity.allowed];
    if (override.severity.blocked) merged.severity.blocked = [...override.severity.blocked];
  }
  if (merged.severity && !merged.severity.allowed && !merged.severity.blocked) {
    delete merged.severity;
  }

  const exclusions = new Set<string>();
  if (base?.exclusions) {
    for (const value of base.exclusions) exclusions.add(value);
  }
  if (override?.exclusions) {
    for (const value of override.exclusions) exclusions.add(value);
  }
  if (exclusions.size > 0) {
    merged.exclusions = Array.from(exclusions);
  }

  if (!merged.age && !merged.sex && !merged.severity && !merged.exclusions) {
    return undefined;
  }

  return merged;
}

export interface PatientNotifier {
  notifyReferral(details: PatientNotification): Promise<void>;
}

export interface PatientNotification {
  serviceRequestId: string;
  organisationId: string;
  summary: string;
  status: string;
  correlationId?: string;
}

function buildServiceRequest(ctx: PharmacyContext): CpcsServiceRequest {
  const timestamp = new Date().toISOString();
  const patientReference =
    ctx.patient && typeof (ctx.patient as Record<string, unknown>).id === 'string'
      ? `Patient/${(ctx.patient as Record<string, unknown>).id as string}`
      : 'Patient/unknown';
  return {
    id: `sr-${ctx.id}`,
    patientReference,
    presentingComplaintCode: ctx.document?.conditionCode ?? 'unknown',
    consentTimestamp: timestamp,
    metadata: {
      severity: ctx.document?.severity ?? 'unspecified',
      eligibilityReason: ctx.eligibilityDecision?.reason ?? 'eligible',
    },
  };
}

function buildReferralSummary(ctx: PharmacyContext): string {
  const condition = ctx.document?.conditionCode ?? 'condition';
  const severity = ctx.document?.severity ?? 'unspecified';
  return `Pharmacy First referral for ${condition} (severity: ${severity})`;
}

async function notifyPatient(ctx: PharmacyContext): Promise<void> {
  if (!ctx.notifier || !ctx.serviceRequest || !ctx.referralSummary) return;
  try {
    await ctx.notifier.notifyReferral({
      serviceRequestId: ctx.serviceRequest.id,
      organisationId: ctx.referralOrgId ?? 'unknown',
      summary: ctx.referralSummary,
      status: ctx.referralResult?.status ?? 'unknown',
      correlationId: ctx.correlationId,
    });
  } catch (error) {
    logger.error('pharmacy.notification.failed', {
      ctxId: ctx.id,
      correlationId: ctx.correlationId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

function buildOutcomeBundle(ctx: PharmacyContext): FhirBundle {
  return {
    id: `bundle-${ctx.id}`,
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        request: { method: 'POST', url: 'ServiceRequest' },
        resource: {
          resourceType: 'ServiceRequest',
          id: ctx.serviceRequest?.id ?? `sr-${ctx.id}`,
          status: ctx.referralResult?.status === 'accepted' ? 'active' : 'revoked',
          intent: 'order',
          code: {
            coding: [
              {
                system: 'http://snomed.info/sct',
                code: ctx.document?.conditionCode ?? 'unknown',
              },
            ],
          },
          note: ctx.referralSummary ? [{ text: ctx.referralSummary }] : undefined,
        },
      },
    ],
  } as FhirBundle;
}

function shouldEscalateAfterReferral(ctx: PharmacyContext): boolean {
  if (ctx.referralError) return true;
  return ctx.referralResult?.status === 'rejected';
}

function shouldEscalateIneligibility(ctx: PharmacyContext): boolean {
  const reason = ctx.eligibilityDecision?.reason;
  return reason === 'severity_blocked' || (typeof reason === 'string' && reason.startsWith('exclusion_'));
}

function buildEscalationTask(ctx: PharmacyContext, reason: string): unknown {
  return {
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    priority: 'stat',
    description: `Escalate pharmacy referral (${reason}) for ${ctx.id}`,
    authoredOn: new Date().toISOString(),
    focus: ctx.serviceRequest ? { reference: `ServiceRequest/${ctx.serviceRequest.id}` } : undefined,
    note: ctx.referralSummary ? [{ text: ctx.referralSummary }] : undefined,
  };
}

function fingerprint(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  const hash = createHash('sha256').update(trimmed).digest('hex');
  return hash.slice(0, 12);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
