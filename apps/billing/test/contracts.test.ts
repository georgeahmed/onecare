import { describe, it, expect } from 'vitest';
import { assertValidBillingClaim, assertValidBillingResponse, BillingContractError } from '../src/adapters/contracts';
import type { BillingClaim, BillingResponse } from '@onecare/events';

describe('Billing contract validators', () => {
  it('accepts a valid claim payload', () => {
    const claim: BillingClaim = {
      claimId: 'claim-123',
      encounterId: 'enc-999',
      amount: 199.5,
      currency: 'GBP',
      metadata: { source: 'sandbox' },
    };
    expect(() => assertValidBillingClaim(claim)).not.toThrow();
  });

  it('rejects invalid claim payloads', () => {
    const claim: BillingClaim = {
      claimId: '',
      encounterId: 'enc-1',
      amount: -1,
      currency: 'ukp',
    };
    expect(() => assertValidBillingClaim(claim)).toThrow(BillingContractError);
  });

  it('accepts valid billing responses and rejects invalid ones', () => {
    const response: BillingResponse = {
      claimId: 'claim-1',
      status: 'accepted',
    };
    expect(() => assertValidBillingResponse(response)).not.toThrow();

    const invalid: BillingResponse = {
      claimId: '',
      status: 'accepted',
      reason: '',
    };
    expect(() => assertValidBillingResponse(invalid)).toThrow(BillingContractError);
  });
});
