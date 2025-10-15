import type { ResolvedConfig } from '@onecare/config';
import type { PharmacyReferral } from '@onecare/events';
import type { FhirRepository, IdempotencyStore } from '@onecare/ports';
import type { CpcsClient, CpcsServiceRequest, CpcsSlot, ReferralOptions } from './adapters/cpcs.client';
import { assertValidPharmacyReferral } from './adapters/contracts';
import type { EligibilityDocument, EligibilityPatient } from './application/eligibility';
import {
  runPharmacyReferral,
  type PharmacyRouterResult,
} from './application/router';
import type { PharmacyContext } from './application/pharmacy.state';
import type { PatientNotifier } from './application/pharmacy.state';

export interface PharmacyReferralRequest {
  patientId: string;
  document: EligibilityDocument;
  patient: EligibilityPatient;
  organisationId: string;
  slot?: CpcsSlot;
  referralOptions?: ReferralOptions;
  correlationId?: string;
  contextId?: string;
  serviceRequestOverride?: CpcsServiceRequest;
  summaryOverride?: string;
}

export interface PharmacyRouterDependencies {
  cpcsClient: CpcsClient;
  config: ResolvedConfig;
  fhirRepository: FhirRepository;
  notifier?: PatientNotifier;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlSeconds?: number;
}

export async function handlePharmacyReferral(
  request: PharmacyReferralRequest,
  deps: PharmacyRouterDependencies,
): Promise<PharmacyRouterResult> {
  const referralPayload: PharmacyReferral = {
    patientId: request.patientId,
    condition: request.document.conditionCode,
    pharmacyOrg: request.organisationId.trim(),
    slot: request.slot
      ? {
          start: request.slot.start,
          end: request.slot.end,
          locationOdsCode: request.slot.locationOdsCode,
          reference: request.slot.reference,
        }
      : undefined,
  };
  if (typeof request.patient.ageYears === 'number' && Number.isFinite(request.patient.ageYears)) {
    referralPayload.patientAgeYears = request.patient.ageYears;
  }
  if (request.patient.sex) {
    referralPayload.patientSex = request.patient.sex;
  }
  if (request.document.severity) {
    referralPayload.severity = request.document.severity;
  }
  const exclusionFlags = new Set<string>();
  if (Array.isArray(request.document.exclusionFlags)) {
    for (const flag of request.document.exclusionFlags) {
      if (typeof flag === 'string' && flag.trim().length > 0) {
        exclusionFlags.add(flag.trim());
      }
    }
  }
  if (Array.isArray(request.patient.exclusionFlags)) {
    for (const flag of request.patient.exclusionFlags) {
      if (typeof flag === 'string' && flag.trim().length > 0) {
        exclusionFlags.add(flag.trim());
      }
    }
  }
  if (exclusionFlags.size > 0) {
    referralPayload.exclusionFlags = Array.from(exclusionFlags);
  }
  assertValidPharmacyReferral(referralPayload);

  const context: PharmacyContext = {
    id: request.contextId ?? `ctx-${Date.now()}`,
    patientId: request.patientId,
    document: request.document,
    patient: request.patient,
    config: deps.config,
    cpcsClient: deps.cpcsClient,
    fhirRepository: deps.fhirRepository,
    notifier: deps.notifier,
    serviceRequest: request.serviceRequestOverride,
    referralSummary: request.summaryOverride,
    referralOrgId: request.organisationId.trim(),
    referralSlot: request.slot,
    referralOptions: request.referralOptions,
    correlationId: request.correlationId,
    referralPayload,
    idempotencyStore: deps.idempotencyStore,
    idempotencyTtlSeconds: deps.idempotencyTtlSeconds,
  };

  return runPharmacyReferral(context);
}

export type { PharmacyRouterResult } from './application/router';
export { PharmacyRouterConsumer } from './adapters/consumer';
export { validatePharmacyReferralIngress, buildReferralRequest } from './adapters/referralIngress';
