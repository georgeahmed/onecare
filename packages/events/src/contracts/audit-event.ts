// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface AuditEvent {
  type: string;
  timestamp: string;
  correlationId?: string | null;
  actor?: string | null;
  details?: {
    [k: string]: unknown;
  } | null;
}
