import type { ResolvedConfig } from '@onecare/config';
import type { PharmacyReferral } from '@onecare/events';
import type { FhirRepository } from '@onecare/ports';
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
        }
      : undefined,
  };
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
  };

  return runPharmacyReferral(context);
}

export type { PharmacyRouterResult } from './application/router';
