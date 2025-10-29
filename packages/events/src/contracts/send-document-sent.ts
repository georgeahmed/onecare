// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface SendDocumentSent {
  taskId: string;
  patientId: string;
  messageId: string;
  mexTo: string;
  mexWorkflowId: string;
  mexAckWorkflowId?: string;
  mexLocalId: string;
  sentAt: string;
  attempt: number;
  retryAfter?: string | null;
}
