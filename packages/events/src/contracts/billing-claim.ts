// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface BillingClaim {
  claimId: string;
  encounterId: string;
  amount: number;
  currency: string;
  metadata?: {
    [k: string]: unknown;
  };
}
