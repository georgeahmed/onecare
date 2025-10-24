// AUTO-GENERATED from schemas. DO NOT EDIT.

export type PharmacyOutcomeStatus = "accepted" | "queued" | "rejected";
export type PharmacyOutcomeSlot = {
  start: string;
  end: string;
} | null;

export interface PharmacyOutcome {
  serviceRequestId: string;
  organisationId: string;
  status: PharmacyOutcomeStatus;
  referralReference: string;
  code?: string;
  message?: string;
  summary?: string;
  condition?: string;
  severity?: string;
  slot?: PharmacyOutcomeSlot;
  recordedAt: string;
  escalated?: boolean;
}
