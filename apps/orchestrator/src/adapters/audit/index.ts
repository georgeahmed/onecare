import { logger } from '@onecare/observability';
import type { AuditEvent as LedgerEvent, AuditLedger } from '@onecare/ports';

interface AuditDetails {
  correlationId?: string;
  payload?: unknown;
}

class ConsoleAuditLedger implements AuditLedger {
  async write(event: LedgerEvent): Promise<void> {
    logger.info('audit ledger write', {
      type: event.type,
      correlationId: event.correlationId,
    });
  }
}

let activeLedger: AuditLedger = new ConsoleAuditLedger();

export function createAuditEvent(type: string, details: AuditDetails = {}): LedgerEvent {
  return {
    type,
    ts: new Date().toISOString(),
    correlationId: details.correlationId,
    payload: details.payload,
  };
}

export function getAuditLedger(): AuditLedger {
  return activeLedger;
}

export function setAuditLedger(ledger: AuditLedger): void {
  activeLedger = ledger;
}

export function resetAuditLedger(): void {
  activeLedger = new ConsoleAuditLedger();
}
