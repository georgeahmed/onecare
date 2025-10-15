import { validate, type ValidationError } from '@onecare/domain';
import { Topics, type TypedEnvelope, type PharmacyReferral } from '@onecare/events';
import type { PharmacyReferralRequest } from '../index';

const ENVELOPE_SCHEMA_ID = 'https://onecare/schemas/common/event-envelope.json';
const PHARMACY_REFERRAL_SCHEMA_ID = 'https://onecare/schemas/pharmacy/pharmacy-referral.json';

export type ValidationIssue = {
  path: string;
  keyword: string;
  message?: string;
};

export type ReferralIngressValidation =
  | {
      ok: true;
      envelope: TypedEnvelope<PharmacyReferral>;
      payload: PharmacyReferral;
      correlationId?: string;
    }
  | {
      ok: false;
      reason: 'invalid_envelope' | 'invalid_topic' | 'invalid_payload';
      errors: ValidationIssue[];
      correlationId?: string;
    };

export function validatePharmacyReferralIngress(raw: unknown): ReferralIngressValidation {
  const envelopeResult = validate(ENVELOPE_SCHEMA_ID, raw);
  if (!envelopeResult.ok) {
    return {
      ok: false,
      reason: 'invalid_envelope',
      errors: sanitizeErrors(envelopeResult.errors),
    };
  }

  const envelope = raw as TypedEnvelope<PharmacyReferral>;
  if (envelope.topic !== Topics.pharmacy.referral) {
    return {
      ok: false,
      reason: 'invalid_topic',
      errors: [
        {
          path: '/topic',
          keyword: 'const',
          message: `expected ${Topics.pharmacy.referral}`,
        },
      ],
      correlationId: envelope.correlationId,
    };
  }

  const payloadResult = validate(PHARMACY_REFERRAL_SCHEMA_ID, envelope.payload);
  if (!payloadResult.ok) {
    return {
      ok: false,
      reason: 'invalid_payload',
      errors: sanitizeErrors(payloadResult.errors),
      correlationId: envelope.correlationId,
    };
  }

  return {
    ok: true,
    envelope,
    payload: envelope.payload,
    correlationId: envelope.correlationId,
  };
}

export function buildReferralRequest(envelope: TypedEnvelope<PharmacyReferral>): PharmacyReferralRequest {
  const payload = envelope.payload;
  const documentExclusions = normaliseFlagArray(payload.exclusionFlags);

  const request: PharmacyReferralRequest = {
    patientId: payload.patientId,
    document: {
      conditionCode: payload.condition,
      severity: payload.severity ?? undefined,
      exclusionFlags: documentExclusions,
    },
    patient: {
      id: payload.patientId,
      ageYears: typeof payload.patientAgeYears === 'number' ? payload.patientAgeYears : undefined,
      sex: payload.patientSex ?? undefined,
      exclusionFlags: documentExclusions ? [...documentExclusions] : undefined,
    },
    organisationId: payload.pharmacyOrg,
    slot:
      payload.slot && payload.slot.locationOdsCode
        ? {
            start: payload.slot.start,
            end: payload.slot.end,
            locationOdsCode: payload.slot.locationOdsCode,
            reference: payload.slot.reference,
          }
        : undefined,
    correlationId: envelope.correlationId,
    contextId: envelope.id,
  };

  return request;
}

function sanitizeErrors(errors: ValidationError[]): ValidationIssue[] {
  return errors.map(({ path, keyword, message }) => ({ path, keyword, message }));
}

function normaliseFlagArray(flags: unknown): string[] | undefined {
  if (!Array.isArray(flags)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of flags) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}
