// AUTO-GENERATED from schemas. DO NOT EDIT.

export interface AuditEvent {
  type: string;
  ts: string;
  correlationId?: string | null;
  actorRef?: string | null;
  subjectRef?: string | null;
  outcome?: string | null;
  reasonCode?: string | null;
  details?: {
    [k: string]: unknown;
  } | null;
}
