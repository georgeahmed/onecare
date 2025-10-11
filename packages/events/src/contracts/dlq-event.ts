// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface DlqEvent {
  originalTopic: string;
  failedEnvelopeId: string;
  correlationId?: string;
  reasonCode:
    | "schema_mismatch"
    | "processing_failed"
    | "timeout"
    | "circuit_open"
    | "unauthorized"
    | "forbidden"
    | "conflict";
  errorMessage?: string;
  attempts: number;
  firstSeen?: string;
  lastFailedAt: string;
  payloadDigest?: string;
}
