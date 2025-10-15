import { describe, expect, it } from 'vitest';
import { createEnvelope, Topics, type TypedEnvelope, type PharmacyReferral } from '@onecare/events';
import { buildReferralRequest, validatePharmacyReferralIngress } from '../src/adapters/referralIngress';

function createReferralEnvelope(overrides: Partial<PharmacyReferral> = {}): TypedEnvelope<PharmacyReferral> {
  const payload: PharmacyReferral = {
    patientId: 'patient-1',
    condition: 'UTI',
    pharmacyOrg: 'pharmacy/demo',
    patientAgeYears: 32,
    patientSex: 'female',
    severity: 'mild',
    exclusionFlags: ['pregnant'],
    slot: {
      start: '2025-01-08T09:00:00.000Z',
      end: '2025-01-08T09:15:00.000Z',
      locationOdsCode: 'ODS1',
      reference: 'slot-1',
    },
    ...overrides,
  };
  return createEnvelope(Topics.pharmacy.referral, payload, 'corr-1');
}

describe('referralIngress', () => {
  it('validates envelopes and payloads', () => {
    const envelope = createReferralEnvelope();
    const result = validatePharmacyReferralIngress(envelope);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.payload.patientId).toBe('patient-1');

    const request = buildReferralRequest(result.envelope);
    expect(request.patientId).toBe('patient-1');
    expect(request.document.conditionCode).toBe('UTI');
    expect(request.document.severity).toBe('mild');
    expect(request.patient.ageYears).toBe(32);
    expect(request.slot).toMatchObject({
      locationOdsCode: 'ODS1',
      reference: 'slot-1',
    });
  });

  it('rejects envelopes with wrong topic', () => {
    const envelope = createReferralEnvelope();
    const mutated = { ...envelope, topic: Topics.telephony.callTranscribed };
    const result = validatePharmacyReferralIngress(mutated);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid_topic');
  });

  it('rejects payloads that fail schema validation', () => {
    const envelope = createReferralEnvelope({
      slot: {
        start: 'not-a-date',
        end: '2025-01-08T09:15:00.000Z',
        locationOdsCode: 'ODS1',
      },
    });
    const result = validatePharmacyReferralIngress(envelope);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid_payload');
    expect(result.errors[0]?.path).toContain('/slot/start');
  });

  it('rejects malformed envelope structure', () => {
    const result = validatePharmacyReferralIngress({ topic: Topics.pharmacy.referral });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid_envelope');
  });
});
