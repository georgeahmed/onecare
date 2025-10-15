// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface PharmacyOutcome {
  serviceRequestId: string;
  organisationId: string;
  status: "accepted" | "queued" | "rejected";
  referralReference: string;
  code?: string;
  message?: string;
  summary?: string;
  condition?: string;
  severity?: string;
  slot?: {
    start: string;
    end: string;
  } | null;
  recordedAt: string;
  escalated?: boolean;
}
