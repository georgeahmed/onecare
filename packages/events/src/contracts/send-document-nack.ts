// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface SendDocumentNack {
  taskId: string;
  patientId: string;
  messageId: string;
  mexLocalId: string;
  reasonCode: string;
  reason?: string;
  receivedAt: string;
  retryable?: boolean;
}
