// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface SendDocumentRetryScheduled {
  taskId: string;
  patientId: string;
  messageId: string;
  mexLocalId: string;
  attempt: number;
  scheduledAt: string;
  reason?: string;
}
