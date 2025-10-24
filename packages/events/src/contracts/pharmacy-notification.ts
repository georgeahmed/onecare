// AUTO-GENERATED from schemas. DO NOT EDIT.

export type PharmacyNotificationStatus = "accepted" | "queued" | "rejected";
export type PharmacyNotificationChannel = "sms" | "email" | "push" | "unknown";
export type PharmacyNotificationMetadata = {
  template?: string;
  locale?: string;
} | null;

export interface PharmacyNotification {
  serviceRequestId: string;
  organisationId: string;
  status: PharmacyNotificationStatus;
  summary: string;
  recordedAt: string;
  channel?: PharmacyNotificationChannel;
  metadata?: PharmacyNotificationMetadata;
}
