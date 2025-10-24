// AUTO-GENERATED from schemas. DO NOT EDIT.

export type BillingResponseStatus = "accepted" | "pending" | "rejected";

export interface BillingResponse {
  claimId: string;
  status: BillingResponseStatus;
  reason?: string | null;
  metadata?: {
    [k: string]: unknown;
  };
}
