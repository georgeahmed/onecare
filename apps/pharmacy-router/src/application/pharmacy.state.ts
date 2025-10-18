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
import type { PharmacyOutcome, PharmacyReferral } from '@onecare/events';
import type { FhirBundle, FhirRepository, FhirResourceRef, IdempotencyStore } from '@onecare/ports';
import { executeWithIdempotency } from '@onecare/ports';
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
import { assertValidPharmacyOutcome } from '../adapters/contracts';

export interface PharmacyContext extends MachineContext {
  patientId?: string;
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
  referralPayload?: PharmacyReferral;
  outcomePayload?: PharmacyOutcome;
  eligibilityDecision?: EligibilityDecision;
  eligibilityRule?: PharmacyEligibilityRule;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
  notificationIdempotencyKey?: string;
  outcomeIdempotencyKey?: string;
}

export interface PharmacyEvent extends MachineEvent {
  type: 'pharmacy.route' | string;
}

const DEFAULT_PHARMACY_IDEMPOTENCY_TTL_SECONDS = 15 * 60;

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
    const outcomePayload = buildOutcomePayload(ctx);
    assertValidPharmacyOutcome(outcomePayload);
    const key = derivePharmacyOutcomeKey(ctx);
    const ttlSeconds = resolvePharmacyIdempotencyTtl(ctx);
    const { status } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key,
      ttlSeconds,
      execute: async () => {
        ctx.outcomeBundle = await ctx.fhirRepository!.upsertBundle(bundle);

        if (shouldEscalateAfterReferral(ctx)) {
          ctx.escalationTaskRef = await ctx.fhirRepository!.createTask(
            buildEscalationTask(ctx, 'referral_failed'),
          );
        }
        logger.info('pharmacy.outcome.persisted', {
          ctxId: ctx.id,
          correlationId: ctx.correlationId,
          key,
          escalated: shouldEscalateAfterReferral(ctx),
        });
        return true;
      },
      onDuplicate: () => {
        logger.warn('pharmacy.outcome.duplicate_suppressed', {
          ctxId: ctx.id,
          correlationId: ctx.correlationId,
          key,
        });
      },
      onError: (error) => {
        logger.error('pharmacy.outcome.idempotency_failed', {
          ctxId: ctx.id,
          correlationId: ctx.correlationId,
          key,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });

    if (status === 'skipped') {
      ctx.outcomeBundle = ctx.outcomeBundle ?? bundle;
    }
    ctx.outcomePayload = outcomePayload;
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
  idempotencyKey?: string;
  channel?: 'sms' | 'email' | 'push' | 'unknown';
  metadata?: PatientNotificationMetadata;
}

export interface PatientNotificationMetadata {
  template?: string;
  locale?: string;
}

function buildServiceRequest(ctx: PharmacyContext): CpcsServiceRequest {
  const timestamp = new Date().toISOString();
  const rawPatientId =
    typeof ctx.patientId === 'string' && ctx.patientId.trim().length > 0
      ? ctx.patientId.trim()
      : typeof ctx.patient?.id === 'string' && ctx.patient.id.trim().length > 0
        ? ctx.patient.id.trim()
        : undefined;
  const patientReference = rawPatientId ? `Patient/${rawPatientId}` : 'Patient/unknown';
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
  const key = derivePharmacyNotificationKey(ctx);
  const ttlSeconds = resolvePharmacyIdempotencyTtl(ctx);
  await executeWithIdempotency({
    store: ctx.idempotencyStore,
    key,
    ttlSeconds,
    execute: async () => {
      try {
        await ctx.notifier!.notifyReferral({
          serviceRequestId: ctx.serviceRequest!.id,
          organisationId: ctx.referralOrgId ?? 'unknown',
          summary: ctx.referralSummary!,
          status: ctx.referralResult?.status ?? 'unknown',
          correlationId: ctx.correlationId,
          idempotencyKey: key,
          channel: 'unknown',
          metadata: { template: 'pharmacy_referral_status' },
        });
        logger.info('pharmacy.notification.sent', {
          ctxId: ctx.id,
          correlationId: ctx.correlationId,
          organisationFingerprint: fingerprint(ctx.referralOrgId),
          key,
        });
      } catch (error) {
        logger.error('pharmacy.notification.failed', {
          ctxId: ctx.id,
          correlationId: ctx.correlationId,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
        throw error;
      }
      return true;
    },
    onDuplicate: () => {
      logger.warn('pharmacy.notification.duplicate_suppressed', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        key,
      });
    },
    onError: (error) => {
      logger.error('pharmacy.notification.idempotency_failed', {
        ctxId: ctx.id,
        correlationId: ctx.correlationId,
        key,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    },
  });
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

function buildOutcomePayload(ctx: PharmacyContext): PharmacyOutcome {
  if (!ctx.serviceRequest?.id) {
    throw new Error('service_request_missing');
  }
  if (!ctx.referralOrgId) {
    throw new Error('referral_org_missing');
  }
  if (!ctx.referralResult) {
    throw new Error('referral_result_missing');
  }

  const payload: PharmacyOutcome = {
    serviceRequestId: ctx.serviceRequest.id,
    organisationId: ctx.referralOrgId,
    status: ctx.referralResult.status,
    referralReference: ctx.referralResult.reference,
    recordedAt: new Date().toISOString(),
  };

  if (ctx.referralResult.code) {
    payload.code = ctx.referralResult.code;
  }
  if (ctx.referralResult.message) {
    payload.message = ctx.referralResult.message;
  }
  if (ctx.referralSummary) {
    payload.summary = ctx.referralSummary;
  }
  if (ctx.document?.conditionCode) {
    payload.condition = ctx.document.conditionCode;
  }
  if (ctx.document?.severity) {
    payload.severity = ctx.document.severity;
  }
  if (ctx.referralSlot) {
    payload.slot = {
      start: ctx.referralSlot.start,
      end: ctx.referralSlot.end,
    };
  }
  if (shouldEscalateAfterReferral(ctx)) {
    payload.escalated = true;
  }

  return payload;
}

function resolvePharmacyIdempotencyTtl(ctx: PharmacyContext): number {
  const ttl = ctx.idempotencyTtlSeconds;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_PHARMACY_IDEMPOTENCY_TTL_SECONDS;
}

function derivePharmacyNotificationKey(ctx: PharmacyContext): string {
  if (ctx.notificationIdempotencyKey) return ctx.notificationIdempotencyKey;
  const organisation = ctx.referralOrgId ?? 'unknown-org';
  const serviceRequestId = ctx.serviceRequest?.id ?? `sr-${ctx.id}`;
  return `pharmacy:notify:${organisation}:${serviceRequestId}`;
}

function derivePharmacyOutcomeKey(ctx: PharmacyContext): string {
  if (ctx.outcomeIdempotencyKey) return ctx.outcomeIdempotencyKey;
  const organisation = ctx.referralOrgId ?? 'unknown-org';
  const serviceRequestId = ctx.serviceRequest?.id ?? `sr-${ctx.id}`;
  return `pharmacy:outcome:${organisation}:${serviceRequestId}`;
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
