export interface AuditEvent {
  type: string;
  ts: string; // ISO time
  correlationId?: string;
  payload?: unknown;
}

export interface AuditLedger {
  write(event: AuditEvent): Promise<void>;
}

