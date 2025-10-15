import { describe, expect, it } from 'vitest';
import type { PharmacyOutcome, PharmacyReferral } from '@onecare/events';
import { assertValidPharmacyOutcome, assertValidPharmacyReferral, ContractValidationError } from '../src/adapters/contracts';

describe('contracts validation', () => {
  it('validates pharmacy referral payloads', () => {
    const payload: PharmacyReferral = {
      patientId: 'patient-1',
      condition: 'flu',
      pharmacyOrg: 'pharmacy/demo',
      slot: {
        start: '2025-01-01T09:00:00.000Z',
        end: '2025-01-01T09:10:00.000Z',
      },
    };
    expect(() => assertValidPharmacyReferral(payload)).not.toThrow();
  });

  it('throws ContractValidationError for invalid referral payloads', () => {
    const payload = {
      condition: '',
      pharmacyOrg: '',
    } as unknown as PharmacyReferral;
    expect(() => assertValidPharmacyReferral(payload)).toThrow(ContractValidationError);
  });

  it('validates pharmacy outcome payloads', () => {
    const payload: PharmacyOutcome = {
      serviceRequestId: 'sr-1',
      organisationId: 'pharmacy/demo',
      status: 'accepted',
      referralReference: 'cpcs-sr-1',
      recordedAt: '2025-01-01T09:15:00.000Z',
    };
    expect(() => assertValidPharmacyOutcome(payload)).not.toThrow();
  });

  it('throws ContractValidationError for invalid outcome payloads', () => {
    const payload = {
      organisationId: 'pharmacy/demo',
      status: 'accepted',
      referralReference: 'cpcs-sr-1',
      recordedAt: 'yesterday',
    } as unknown as PharmacyOutcome;
    expect(() => assertValidPharmacyOutcome(payload)).toThrow(ContractValidationError);
  });
});
