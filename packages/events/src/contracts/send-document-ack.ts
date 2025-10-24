// AUTO-GENERATED from schemas. DO NOT EDIT.

export type SendDocumentAckType = "technical" | "business";
export type SendDocumentAckStatus = "received" | "accepted";

export interface SendDocumentAck {
  taskId: string;
  patientId: string;
  messageId: string;
  mexLocalId: string;
  ackType: SendDocumentAckType;
  status: SendDocumentAckStatus;
  receivedAt: string;
  details?: string;
}
