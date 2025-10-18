// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface PharmacyNotification {
  serviceRequestId: string;
  organisationId: string;
  status: "accepted" | "queued" | "rejected";
  summary: string;
  recordedAt: string;
  channel?: "sms" | "email" | "push" | "unknown";
  metadata?: {
    template?: string;
    locale?: string;
  } | null;
}
