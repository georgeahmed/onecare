export interface AuditEvent {
  type: string;
  ts: string; // ISO time
  correlationId?: string | null;
  actorRef?: string | null;
  subjectRef?: string | null;
  outcome?: AuditOutcome | null;
  reasonCode?: string | null;
  details?: Record<string, unknown> | null;
}

export type AuditOutcome = 'allow' | 'deny' | 'error' | 'unknown';

export interface AuditLedger {
  write(event: AuditEvent): Promise<void>;
}
